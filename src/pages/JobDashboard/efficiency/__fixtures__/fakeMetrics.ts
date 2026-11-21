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
const CPU = /^(sum|count) by \(([^)]+)\) \(rate\(node_cpu_seconds_total\{mode="(idle|iowait)",(.*)\}\[(\d+)s\]\)\)$/;

export class FakeMetrics implements MetricsClient {
  readonly queries: Array<{ kind: 'instant' | 'range'; expr: string; start: number; end: number; step: number }> = [];
  private readonly options: Required<Omit<FakeMetricsOptions, 'failOn'>> & Pick<FakeMetricsOptions, 'failOn'>;

  constructor(options: FakeMetricsOptions = {}) {
    this.options = {
      gpus: [],
      nodes: [],
      scrapeInterval: 30,
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
    // Undo the PromQL string and regex escaping of plain node names.
    const pattern = new RegExp(`^(${match[1]})${match[2] ? ':[0-9]+' : ''}$`);
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

  /**
   * Per instance: the CPUs with a rate in the window (count), or their idle
   * or waiting time in CPUs (sum). Like rate(), this needs two samples in
   * the window and reads the increase between the first and the last one:
   * the interval that ends at the first sample lies outside the window.
   */
  private evaluateCpu(match: RegExpExecArray, time: number): PromSample[] {
    const [, aggregation, instanceLabel, mode, matchers, seconds] = match;
    if (instanceLabel !== this.options.instanceLabel) {
      throw new Error(`FakeMetrics: unexpected grouping label ${instanceLabel}`);
    }
    const selected = this.selects(matchers);
    const samples: PromSample[] = [];
    for (const node of this.options.nodes) {
      if (!selected(node.instance) || (mode === 'iowait' && !node.ioWaitShare)) {
        continue;
      }
      const scrapes = this.scrapes(time, Number(seconds))
        .filter((scrape) => node.busyShare(scrape) !== undefined)
        .reverse();
      if (scrapes.length < 2) {
        continue;
      }
      const shares = scrapes.slice(1).map((scrape) => {
        const waiting = node.ioWaitShare?.(scrape) ?? 0;
        return mode === 'iowait' ? waiting : 1 - (node.busyShare(scrape) ?? 0) - waiting;
      });
      // A CPU has a rate when it has a sample at every scrape of the window.
      const cpus = Math.min(...scrapes.map((scrape) => node.reportingCpus?.(scrape) ?? node.cpus));
      if (cpus <= 0) {
        continue;
      }
      samples.push({ metric: { [instanceLabel]: node.instance }, value: aggregation === 'count' ? cpus : cpus * aggregate('avg', shares) });
    }
    return samples;
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
