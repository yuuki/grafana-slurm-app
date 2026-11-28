/**
 * A MetricsClient that answers the queries of the phase segmentation from a
 * synthetic job. It recognises a query by comparing it with the queries the
 * plugin builds for the same settings, and evaluates it on the grid that the
 * range parameters describe (one window of `step` seconds ending at each
 * evaluation time). Query strings are checked against real backends
 * separately; this fake only keeps the tests free of a network.
 */
import { MetricsClient, PromInstantSample, PromRangeSeries } from '../promClient';
import type { ClusterSummary } from '../../../../api/types';
import { counterMetrics, PROBE_COUNT_LABEL, PROBE_METRIC_LABEL, probeQueryBuilders, QueryPart, signalQueryBuilders, splitToFit } from '../queries';
import { EffectivePhaseSettings } from '../settings';
import { SignalMatrix, SignalName } from '../types';
import { SyntheticJob, toPhaseInput } from './syntheticJob';

export interface FakeMetricsOptions {
  job: SyntheticJob;
  /** Host names of the synthetic job's nodes, in node order. */
  nodeNames: string[];
  settings: EffectivePhaseSettings;
  /** The cluster the queries are built for; the fake splits long queries like the plugin does. */
  cluster: ClusterSummary;
  instanceLabel?: string;
}

export interface FakeMetricsCall {
  kind: 'instant' | 'range';
  expr: string;
  time?: number;
  start?: number;
  end?: number;
  step?: number;
}

export interface FakeMetricsClient extends MetricsClient {
  calls: FakeMetricsCall[];
}

const GPU_PORT = 9400;
const NODE_PORT = 9100;

function isGpuSignal(signal: SignalName): boolean {
  return signal === 'gpuPower' || signal === 'gpuUtilMean' || signal === 'gpuUtilMax';
}

function toSeries(matrix: SignalMatrix | undefined, options: FakeMetricsOptions, port: number, firstTime: number, step: number): PromRangeSeries[] {
  const label = options.instanceLabel ?? 'instance';
  return (matrix ?? [])
    .map((row, node) => {
      const values: Array<[number, number]> = [];
      row.forEach((value, bucket) => {
        if (Number.isFinite(value)) {
          values.push([firstTime + bucket * step, value]);
        }
      });
      return { metric: { [label]: `${options.nodeNames[node]}:${port}` }, values };
    })
    .filter((series) => series.values.length > 0);
}

function countInRange(times: number[], time: number, rangeSeconds: number): number {
  return times.filter((sample) => sample > time - rangeSeconds && sample <= time).length;
}

function probeRange(expr: string): number {
  const match = /\[(\d+)s\]/.exec(expr);
  return match ? Number(match[1]) : 0;
}

/** count_values by (instance) ("samples", count_over_time(...)) over the GPU series. */
function gpuProbe(options: FakeMetricsOptions, time: number, rangeSeconds: number): PromInstantSample[] {
  const label = options.instanceLabel ?? 'instance';
  const groups = new Map<string, PromInstantSample>();
  for (const series of options.job.gpus) {
    const count = countInRange(series.times, time, rangeSeconds);
    if (count === 0) {
      continue;
    }
    const instance = `${options.nodeNames[series.node]}:${GPU_PORT}`;
    const key = `${instance}/${count}`;
    const group = groups.get(key) ?? { metric: { [label]: instance, [PROBE_COUNT_LABEL]: String(count) }, value: 0 };
    group.value += 1;
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * count_values by (phase_metric) ("samples", ...) over the counter series: one
 * CPU, one storage and one network series per node, scraped together.
 */
function counterProbe(options: FakeMetricsOptions, nodes: Set<string>, without: Set<string>, time: number, rangeSeconds: number): PromInstantSample[] {
  const metrics = counterMetrics(options.settings);
  const present = [
    ...(without.has('cpu') ? [] : metrics.cpuBusy),
    ...(without.has('storageWrite') ? [] : metrics.storageWrite.slice(0, 1)),
    ...(without.has('network') ? [] : metrics.network.slice(0, 1)),
  ];
  const groups = new Map<number, number>();
  for (const series of options.job.nodes) {
    const count = nodes.has(options.nodeNames[series.node]) ? countInRange(series.times, time, rangeSeconds) : 0;
    if (count > 0) {
      groups.set(count, (groups.get(count) ?? 0) + 1);
    }
  }
  return present.flatMap((metric) =>
    [...groups].map(([count, series]) => ({ metric: { [PROBE_METRIC_LABEL]: metric, [PROBE_COUNT_LABEL]: String(count) }, value: series }))
  );
}

function findPart(parts: QueryPart[], expr: string): Set<string> | null {
  const part = parts.find((candidate) => candidate.expr === expr);
  return part ? new Set(part.nodes) : null;
}

export function createFakeMetricsClient(options: FakeMetricsOptions): FakeMetricsClient {
  const calls: FakeMetricsCall[] = [];
  const without = new Set<string>(options.job.spec.without ?? []);
  // The six range queries of one analysis share a grid; reduce the samples once per grid.
  const inputs = new Map<string, ReturnType<typeof toPhaseInput>>();
  const inputFor = (start: number, end: number, step: number) => {
    const key = `${start}/${end}/${step}`;
    const cached = inputs.get(key);
    if (cached) {
      return cached;
    }
    const input = toPhaseInput(options.job, { startSec: start - step, stepSec: step, bucketCount: Math.floor((end - start) / step) + 1 });
    inputs.set(key, input);
    return input;
  };
  const ofNodes = <T extends { metric: Record<string, string> }>(items: T[], nodes: Set<string>): T[] => {
    const label = options.instanceLabel ?? 'instance';
    return items.filter((item) => nodes.has(item.metric[label].replace(/:[0-9]+$/, '')));
  };
  return {
    calls,
    async instant(expr, time) {
      calls.push({ kind: 'instant', expr, time });
      const rangeSeconds = probeRange(expr);
      const probes = probeQueryBuilders(options.settings, rangeSeconds);
      const gpuNodes = findPart(splitToFit(options.nodeNames, options.cluster, probes.gpu), expr);
      if (gpuNodes) {
        return without.has('gpuUtil') ? [] : ofNodes(gpuProbe(options, time, rangeSeconds), gpuNodes);
      }
      const counterNodes = findPart(splitToFit(options.nodeNames, options.cluster, probes.counters), expr);
      if (counterNodes) {
        return counterProbe(options, counterNodes, without, time, rangeSeconds);
      }
      throw new Error(`fake metrics: unknown instant query ${expr}`);
    },
    async range(expr, start, end, step) {
      calls.push({ kind: 'range', expr, start, end, step });
      for (const query of signalQueryBuilders(options.settings, step)) {
        const nodes = findPart(splitToFit(options.nodeNames, options.cluster, query.build), expr);
        if (nodes) {
          const input = inputFor(start, end, step);
          return ofNodes(toSeries(input.signals[query.signal], options, isGpuSignal(query.signal) ? GPU_PORT : NODE_PORT, start, step), nodes);
        }
      }
      throw new Error(`fake metrics: unknown range query ${expr}`);
    },
  };
}
