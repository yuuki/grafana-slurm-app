/**
 * A fake metrics backend for tests: it holds scraped samples and evaluates
 * the query shapes of buildEfficiencyQueries and of the Job Search idle GPU
 * batch like Prometheus does (range selectors that look back from the
 * evaluation time, aggregation by instance and GPU). It evaluates only those
 * shapes; any other query throws.
 */
import { MetricsClient, PromSample, PromSeries } from '../promClient';

/** Value of a series at a scrape time; undefined means the scrape is missing. */
type Reading = (time: number) => number | undefined;

export interface FakeGpu {
  /** Value of the instance label, for example "gpu-node001:9400". */
  instance: string;
  /** Value of the GPU ID label; undefined leaves the label off the series. */
  gpu?: string;
  utilization: Reading;
  usedMiB?: Reading;
  freeMiB?: Reading;
}

export interface FakeNode {
  /** Value of the instance label, for example "gpu-node001:9100". */
  instance: string;
  cpus: number;
  /**
   * Share of each CPU's time that is busy, and that waits for I/O, in the
   * scrape interval that ends at the given time; undefined means no scrape.
   */
  busyShare: Reading;
  /** Omit to export no "iowait" mode at all. */
  ioWaitShare?: Reading;
  /** CPUs with a sample at a scrape; all of them when omitted. */
  reportingCpus?: Reading;
}

export interface FakeMetricsOptions {
  gpus?: FakeGpu[];
  nodes?: FakeNode[];
  scrapeInterval?: number;
  /**
   * How rate() treats the start of its window. "prometheus" reads the
   * increase between the first and the last sample inside the window.
   * "metricsql" (VictoriaMetrics) starts from the last sample before the
   * window when there is one a scrape interval earlier, so the rate also
   * covers the scrape interval that ends at the first sample inside.
   */
  rateSemantics?: 'prometheus' | 'metricsql';
  /** Queries matching this pattern are rejected. */
  failOn?: RegExp;
  /** Label names; the defaults are those of the DCGM exporter. */
  instanceLabel?: string;
  gpuLabel?: string;
  /** Metric names; the defaults are those of the DCGM exporter. */
  utilizationMetric?: string;
  usedMetric?: string;
  freeMetric?: string;
}

const PER_GPU = /^(max|avg|min) by \(([^,]+), ([^)]+)\) \((max|avg|min)_over_time\(([A-Za-z_:][A-Za-z0-9_:]*)\{(.*)\}\[(\d+)s\]\)\)$/;
const PER_NODE = /^count by \(([^)]+)\) \(max_over_time\(([A-Za-z_:][A-Za-z0-9_:]*)\{(.*)\}\[(\d+)s\]\)(?: > ([0-9.]+))?\)$/;
const CPU = /^sum by \(([^)]+)\) \(rate\(node_cpu_seconds_total\{mode="(idle|iowait)",(.*)\}\[(\d+)s\]\)\)$/;
const CPU_SAMPLES = /^count_values by \(([^)]+)\) \("([^"]+)", count_over_time\(node_cpu_seconds_total\{mode="idle",(.*)\}\[(\d+)s\]\)\)$/;

export class FakeMetrics implements MetricsClient {
  readonly queries: Array<{ kind: 'instant' | 'range'; expr: string; start: number; end: number; step: number }> = [];
  private readonly options: Required<Omit<FakeMetricsOptions, 'failOn'>> & Pick<FakeMetricsOptions, 'failOn'>;

  constructor(options: FakeMetricsOptions = {}) {
    this.options = {
      gpus: [],
      nodes: [],
      scrapeInterval: 30,
      rateSemantics: 'prometheus',
      instanceLabel: 'instance',
      gpuLabel: 'gpu',
      utilizationMetric: 'DCGM_FI_DEV_GPU_UTIL',
      usedMetric: 'DCGM_FI_DEV_FB_USED',
      freeMetric: 'DCGM_FI_DEV_FB_FREE',
      ...options,
    };
  }

  async instant(expr: string, time: number): Promise<PromSample[]> {
    this.queries.push({ kind: 'instant', expr, start: time, end: time, step: 0 });
    return this.evaluate(expr, time).map(({ metric, value }) => ({ metric, value }));
  }

  async range(expr: string, start: number, end: number, step: number): Promise<PromSeries[]> {
    this.queries.push({ kind: 'range', expr, start, end, step });
    const series = new Map<string, PromSeries>();
    for (let time = start; time <= end; time += step) {
      for (const { metric, value } of this.evaluate(expr, time)) {
        const key = JSON.stringify(metric);
        const entry = series.get(key) ?? { metric, values: [] };
        entry.values.push([time, value]);
        series.set(key, entry);
      }
    }
    return [...series.values()];
  }

  private evaluate(expr: string, time: number): PromSample[] {
    if (this.options.failOn?.test(expr)) {
      throw new Error('Metrics query failed (HTTP 500: fake failure)');
    }
    const perGpu = PER_GPU.exec(expr);
    if (perGpu) {
      return this.evaluatePerGpu(perGpu, time);
    }
    const perNode = PER_NODE.exec(expr);
    if (perNode) {
      return this.evaluatePerNode(perNode, time);
    }
    const cpu = CPU.exec(expr);
    if (cpu) {
      return this.evaluateCpu(cpu, time);
    }
    const cpuSamples = CPU_SAMPLES.exec(expr);
    if (cpuSamples) {
      return this.evaluateCpuSamples(cpuSamples, time);
    }
    throw new Error(`FakeMetrics cannot evaluate: ${expr}`);
  }

  /** Scrape times in the window (time - seconds, time]. */
  private scrapes(time: number, seconds: number): number[] {
    const interval = this.options.scrapeInterval;
    const times: number[] = [];
    for (let scrape = Math.floor(time / interval) * interval; scrape > time - seconds; scrape -= interval) {
      times.push(scrape);
    }
    return times;
  }

  /** The node names a selector such as instance=~"(a|b):[0-9]+" admits. */
  private selects(matchers: string): (instance: string) => boolean {
    const match = /=~"\((.*)\)(:\[0-9\]\+)?"/.exec(matchers);
    if (!match) {
      throw new Error(`FakeMetrics: no instance matcher in {${matchers}}`);
    }
    // Read the PromQL string as Prometheus does (\\ is a backslash, \" a
    // quote, \n a line break); what is left is the regex.
    const regex = match[1].replace(/\\([\\"n])/g, (_, escaped: string) => (escaped === 'n' ? '\n' : escaped));
    const pattern = new RegExp(`^(${regex})${match[2] ? ':[0-9]+' : ''}$`);
    return (instance) => pattern.test(instance);
  }

  private evaluatePerGpu(match: RegExpExecArray, time: number): PromSample[] {
    const [, outer, instanceLabel, gpuLabel, inner, metric, matchers, seconds] = match;
    if (outer !== inner) {
      throw new Error(`FakeMetrics: mixed aggregations in ${match[0]}`);
    }
    if (instanceLabel !== this.options.instanceLabel || gpuLabel !== this.options.gpuLabel) {
      // Grouping by a label the series do not carry merges every GPU.
      throw new Error(`FakeMetrics: unexpected grouping labels ${instanceLabel}, ${gpuLabel}`);
    }
    const readings: Record<string, (gpu: FakeGpu) => Reading | undefined> = {
      [this.options.utilizationMetric]: (gpu) => gpu.utilization,
      [this.options.usedMetric]: (gpu) => gpu.usedMiB,
      [this.options.freeMetric]: (gpu) => gpu.freeMiB,
    };
    const reading = readings[metric];
    if (!reading) {
      return [];
    }
    const selected = this.selects(matchers);
    const samples: PromSample[] = [];
    for (const gpu of this.options.gpus) {
      const read = reading(gpu);
      if (!read || !selected(gpu.instance)) {
        continue;
      }
      const values = this.scrapes(time, Number(seconds))
        .map((scrape) => read(scrape))
        .filter((value): value is number => value !== undefined);
      if (values.length === 0) {
        continue;
      }
      const metricLabels: Record<string, string> = { [instanceLabel]: gpu.instance };
      if (gpu.gpu !== undefined) {
        metricLabels[gpuLabel] = gpu.gpu;
      }
      samples.push({ metric: metricLabels, value: aggregate(inner, values) });
    }
    return samples;
  }

  /** GPUs per instance whose bucket peak exists, or exceeds the threshold when one is given. */
  private evaluatePerNode(match: RegExpExecArray, time: number): PromSample[] {
    const [, instanceLabel, metric, matchers, seconds, threshold] = match;
    if (instanceLabel !== this.options.instanceLabel || metric !== this.options.utilizationMetric) {
      return [];
    }
    const selected = this.selects(matchers);
    const counts = new Map<string, number>();
    for (const gpu of this.options.gpus) {
      if (!selected(gpu.instance)) {
        continue;
      }
      const values = this.scrapes(time, Number(seconds))
        .map((scrape) => gpu.utilization(scrape))
        .filter((value): value is number => value !== undefined);
      if (values.length === 0 || (threshold !== undefined && Math.max(...values) <= Number(threshold))) {
        continue;
      }
      counts.set(gpu.instance, (counts.get(gpu.instance) ?? 0) + 1);
    }
    return [...counts.entries()].map(([instance, value]) => ({ metric: { [instanceLabel]: instance }, value }));
  }

  /** The scrape times of a node in the window (time - seconds, time], oldest first. */
  private nodeScrapes(node: FakeNode, time: number, seconds: number): number[] {
    return this.scrapes(time, seconds)
      .filter((scrape) => node.busyShare(scrape) !== undefined)
      .reverse();
  }

  /** For each CPU of a node, the number of samples it has at the given scrapes. */
  private samplesPerCpu(node: FakeNode, scrapes: number[]): number[] {
    return Array.from({ length: node.cpus }, (_, cpu) => scrapes.filter((scrape) => (node.reportingCpus?.(scrape) ?? node.cpus) > cpu).length);
  }

  /**
   * Per instance: the idle or waiting time of its CPUs in the window, in
   * CPUs. Like rate(), this reads the increase between two samples. With
   * the Prometheus rule both lie inside the window, so the scrape interval
   * that ends at the first sample inside is not read. With the MetricsQL
   * rule the first of the two is the last sample before the window, so
   * that interval is read too. A CPU without two samples has no rate.
   */
  private evaluateCpu(match: RegExpExecArray, time: number): PromSample[] {
    const [, instanceLabel, mode, matchers, seconds] = match;
    if (instanceLabel !== this.options.instanceLabel) {
      throw new Error(`FakeMetrics: unexpected grouping label ${instanceLabel}`);
    }
    const selected = this.selects(matchers);
    const samples: PromSample[] = [];
    for (const node of this.options.nodes) {
      if (!selected(node.instance) || (mode === 'iowait' && !node.ioWaitShare)) {
        continue;
      }
      const scrapes = this.nodeScrapes(node, time, Number(seconds));
      if (scrapes.length < 2) {
        continue;
      }
      const cpus = this.samplesPerCpu(node, scrapes).filter((count) => count >= 2).length;
      if (cpus === 0) {
        continue;
      }
      const hasSampleBefore = node.busyShare(scrapes[0] - this.options.scrapeInterval) !== undefined;
      const intervals = this.options.rateSemantics === 'metricsql' && hasSampleBefore ? scrapes : scrapes.slice(1);
      const shares = intervals.map((scrape) => {
        const waiting = node.ioWaitShare?.(scrape) ?? 0;
        return mode === 'iowait' ? waiting : 1 - (node.busyShare(scrape) ?? 0) - waiting;
      });
      samples.push({ metric: { [instanceLabel]: node.instance }, value: cpus * aggregate('avg', shares) });
    }
    return samples;
  }

  /** Per instance and number of samples: the CPU series that hold that many samples in the window. */
  private evaluateCpuSamples(match: RegExpExecArray, time: number): PromSample[] {
    const [, instanceLabel, samplesLabel, matchers, seconds] = match;
    if (instanceLabel !== this.options.instanceLabel) {
      throw new Error(`FakeMetrics: unexpected grouping label ${instanceLabel}`);
    }
    const selected = this.selects(matchers);
    const result: PromSample[] = [];
    for (const node of this.options.nodes) {
      if (!selected(node.instance)) {
        continue;
      }
      const cpusBySamples = new Map<number, number>();
      for (const count of this.samplesPerCpu(node, this.nodeScrapes(node, time, Number(seconds)))) {
        if (count > 0) {
          cpusBySamples.set(count, (cpusBySamples.get(count) ?? 0) + 1);
        }
      }
      for (const [count, cpus] of cpusBySamples) {
        result.push({ metric: { [instanceLabel]: node.instance, [samplesLabel]: String(count) }, value: cpus });
      }
    }
    return result;
  }
}

function aggregate(kind: string, values: number[]): number {
  switch (kind) {
    case 'max':
      return Math.max(...values);
    case 'min':
      return Math.min(...values);
    default:
      return values.reduce((sum, value) => sum + value, 0) / values.length;
  }
}
