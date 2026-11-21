import { ClusterSummary, JobRecord } from '../../../api/types';
import { MetricsClient, PromSeries } from './promClient';
import { buildEfficiencyQueries, EfficiencyQueries, instanceToNode } from './queries';
import {
  BottleneckInput,
  BottleneckScore,
  GpuBucketSeries,
  gpuKey,
  GpuMemoryReading,
  GpuScore,
  MemoryScore,
  NodeCpuSeries,
  scoreBottleneck,
  scoreGpus,
  scoreMemory,
  unreadBottleneck,
} from './score';
import { efficiencySettingsErrors, ResolvedEfficiencySettings, resolveEfficiencySettings } from './settings';
import { bucketIndex, CpuWindows, cpuWindowIndex, planCpuWindows, planScoreWindow, ScoredWindow } from './window';

/**
 * Why a job has no scorecard. Each reason is a state of its own: none of
 * them means that the job was efficient or wasteful.
 */
export type NotComputedReason =
  | 'no-datasource'
  | 'invalid-settings'
  | 'not-started'
  | 'no-gpus-allocated'
  | 'too-short'
  | 'too-large'
  | 'missing-gpu-label';

export type JobEfficiency =
  | {
      kind: 'not-computed';
      reason: NotComputedReason;
      /** Elapsed seconds (too-short), estimated GPU count (too-large). */
      value?: number;
      /** Problems with the cluster's efficiency settings (invalid-settings). */
      errors?: string[];
      settings: ResolvedEfficiencySettings;
    }
  | {
      /** GPUs are allocated, but the utilization metric has no series for the job's nodes and time. */
      kind: 'no-telemetry';
      window: ScoredWindow;
      settings: ResolvedEfficiencySettings;
    }
  | {
      kind: 'scored';
      window: ScoredWindow;
      settings: ResolvedEfficiencySettings;
      gpu: GpuScore;
      memory: MemoryScore;
      bottleneck: BottleneckScore;
    };

/** The most queries one scorecard sends; they run one after another. */
export const MAX_QUERIES_PER_SCORECARD = 8;

interface GpuSeriesResult {
  series: GpuBucketSeries[];
  /** True when a series carries no GPU ID label, so GPUs cannot be told apart. */
  missingGpuLabel: boolean;
}

function toGpuBucketSeries(
  peak: PromSeries[],
  mean: PromSeries[],
  window: ScoredWindow,
  cluster: ClusterSummary,
  settings: ResolvedEfficiencySettings
): GpuSeriesResult {
  const byGpu = new Map<string, GpuBucketSeries>();
  let missingGpuLabel = false;

  const fill = (items: PromSeries[], field: 'peak' | 'mean') => {
    for (const item of items) {
      const instance = item.metric[cluster.instanceLabel];
      if (!instance) {
        continue;
      }
      const gpu = item.metric[settings.gpuIdLabel];
      if (!gpu) {
        missingGpuLabel = true;
        continue;
      }
      const key = gpuKey(instance, gpu);
      let entry = byGpu.get(key);
      if (!entry) {
        entry = {
          instance,
          node: instanceToNode(instance, cluster.nodeMatcherMode),
          gpu,
          peak: new Array<number | undefined>(window.buckets).fill(undefined),
          mean: new Array<number | undefined>(window.buckets).fill(undefined),
        };
        byGpu.set(key, entry);
      }
      for (const [timestamp, value] of item.values) {
        const index = bucketIndex(window, timestamp);
        if (index >= 0) {
          entry[field][index] = value;
        }
      }
    }
  };
  fill(peak, 'peak');
  fill(mean, 'mean');

  return { series: [...byGpu.values()], missingGpuLabel };
}

/** Each GPU's memory over the scored window, from the per-bucket highest use and lowest free memory. */
function toGpuMemory(
  used: PromSeries[],
  free: PromSeries[],
  window: ScoredWindow,
  cluster: ClusterSummary,
  settings: ResolvedEfficiencySettings
): Map<string, GpuMemoryReading> {
  const perBucket = (series: PromSeries[]) => {
    const byGpu = new Map<string, Array<number | undefined>>();
    for (const item of series) {
      const instance = item.metric[cluster.instanceLabel];
      const gpu = item.metric[settings.gpuIdLabel];
      if (!instance || !gpu) {
        continue;
      }
      const key = gpuKey(instance, gpu);
      const values = byGpu.get(key) ?? new Array<number | undefined>(window.buckets).fill(undefined);
      for (const [timestamp, value] of item.values) {
        const index = bucketIndex(window, timestamp);
        if (index >= 0) {
          values[index] = value;
        }
      }
      byGpu.set(key, values);
    }
    return byGpu;
  };
  const freeByGpu = perBucket(free);
  const readings = new Map<string, GpuMemoryReading>();
  for (const [key, usedValues] of perBucket(used)) {
    const freeValues = freeByGpu.get(key) ?? [];
    const reading: GpuMemoryReading = { coveredBuckets: 0 };
    for (let bucket = 0; bucket < window.buckets; bucket++) {
      const usedMiB = usedValues[bucket];
      const freeMiB = freeValues[bucket];
      reading.peakUsedMiB = usedMiB === undefined ? reading.peakUsedMiB : Math.max(reading.peakUsedMiB ?? usedMiB, usedMiB);
      reading.minFreeMiB = freeMiB === undefined ? reading.minFreeMiB : Math.min(reading.minFreeMiB ?? freeMiB, freeMiB);
      reading.coveredBuckets += usedMiB !== undefined && freeMiB !== undefined ? 1 : 0;
    }
    readings.set(key, reading);
  }
  return readings;
}

/** Per node, one value per CPU window from a query grouped by instance; the instances of one node add up. */
function toNodeWindowValues(series: PromSeries[], cluster: ClusterSummary, windows: CpuWindows): Map<string, Array<number | undefined>> {
  const byNode = new Map<string, Array<number | undefined>>();
  for (const item of series) {
    const instance = item.metric[cluster.instanceLabel];
    if (!instance) {
      continue;
    }
    const node = instanceToNode(instance, cluster.nodeMatcherMode);
    const values = byNode.get(node) ?? new Array<number | undefined>(windows.count).fill(undefined);
    for (const [timestamp, value] of item.values) {
      const index = cpuWindowIndex(windows, timestamp);
      if (index >= 0) {
        values[index] = (values[index] ?? 0) + value;
      }
    }
    byNode.set(node, values);
  }
  return byNode;
}

function toNodeCpuSeries(
  responses: { idle: PromSeries[]; ioWait: PromSeries[]; count: PromSeries[] },
  cluster: ClusterSummary,
  windows: CpuWindows
): NodeCpuSeries[] {
  const idle = toNodeWindowValues(responses.idle, cluster, windows);
  const ioWait = toNodeWindowValues(responses.ioWait, cluster, windows);
  const none = new Array<number | undefined>(windows.count).fill(undefined);
  return [...toNodeWindowValues(responses.count, cluster, windows).entries()].map(([node, count]) => ({
    node,
    count,
    idle: idle.get(node) ?? none,
    ioWait: ioWait.get(node) ?? none,
  }));
}

/** For each GPU on the job's nodes, its mean utilization per CPU window. */
function toGpuWindowMeans(
  series: PromSeries[],
  job: JobRecord,
  cluster: ClusterSummary,
  settings: ResolvedEfficiencySettings,
  windows: CpuWindows
): Array<Array<number | undefined>> {
  const jobNodes = new Set(job.nodes);
  const byGpu = new Map<string, Array<number | undefined>>();
  for (const item of series) {
    const instance = item.metric[cluster.instanceLabel];
    const gpu = item.metric[settings.gpuIdLabel];
    if (!instance || !gpu || !jobNodes.has(instanceToNode(instance, cluster.nodeMatcherMode))) {
      continue;
    }
    const key = gpuKey(instance, gpu);
    const values = byGpu.get(key) ?? new Array<number | undefined>(windows.count).fill(undefined);
    for (const [timestamp, value] of item.values) {
      const index = cpuWindowIndex(windows, timestamp);
      if (index >= 0) {
        values[index] = value;
      }
    }
    byGpu.set(key, values);
  }
  return [...byGpu.values()];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'query failed';
}

interface ScoreContext {
  job: JobRecord;
  cluster: ClusterSummary;
  settings: ResolvedEfficiencySettings;
  client: MetricsClient;
  queries: EfficiencyQueries;
}

async function readMemory(context: ScoreContext, window: ScoredWindow, gpu: GpuScore): Promise<MemoryScore> {
  const { cluster, settings, client, queries } = context;
  try {
    const rangeStart = window.gridStart + window.step;
    const used = await client.range(queries.gpuMemoryPeak, rangeStart, window.gridEnd, window.step);
    const free = await client.range(queries.gpuMemoryMinFree, rangeStart, window.gridEnd, window.step);
    return scoreMemory(gpu, toGpuMemory(used, free, window, cluster, settings), window.buckets, settings.lowGpuMemoryPercent);
  } catch (error) {
    return { status: 'failed', gpusWithCapacity: 0, gpusCovered: 0, error: errorMessage(error) };
  }
}

async function readBottleneck(context: ScoreContext, windows: CpuWindows, gpu: GpuScore): Promise<BottleneckScore> {
  const { job, cluster, settings, client, queries } = context;
  const input: BottleneckInput = {
    gpuAttribution: gpu.attribution,
    allocatedGpus: job.gpusTotal,
    gpuMeans: [],
    jobNodes: job.nodes,
    cpu: [],
    windowCount: windows.count,
    coverage: windows.coverage,
    idleBaselinePercent: settings.idleGpuUtilizationPercent,
    allocatedCpus: job.cpusTotal ?? 0,
  };
  if (gpu.attribution !== 'exact' || windows.count === 0) {
    // Inconclusive whatever the CPUs did: no need to query them.
    return scoreBottleneck(input);
  }
  if (gpu.activeGpus === 0) {
    return unreadBottleneck(input, { status: 'not-applicable', reason: 'no-active-gpu' });
  }
  try {
    // Window k (0-based) ends at start + (k+1)*step and looks back windows.seconds.
    const start = windows.start + windows.step;
    const end = windows.start + windows.count * windows.step;
    const gpuMeans = await client.range(queries.gpuWindowMean, start, end, windows.step);
    const idle = await client.range(queries.cpuIdle, start, end, windows.step);
    const ioWait = await client.range(queries.cpuIoWait, start, end, windows.step);
    const count = await client.range(queries.cpuCount, start, end, windows.step);
    return scoreBottleneck({
      ...input,
      gpuMeans: toGpuWindowMeans(gpuMeans, job, cluster, settings, windows),
      cpu: toNodeCpuSeries({ idle, ioWait, count }, cluster, windows),
    });
  } catch (error) {
    return unreadBottleneck(input, { status: 'failed', error: errorMessage(error) });
  }
}

/**
 * Computes a job's efficiency scorecard.
 *
 * Cost: at most MAX_QUERIES_PER_SCORECARD queries, sent one after another.
 * The four per-GPU range queries (utilization peak and mean, memory use
 * and free memory) return GPUs x buckets points each, which planScoreWindow
 * keeps under POINT_BUDGET, and one evaluation reads the samples of one
 * bucket; the four queries of the CPU and I/O finding
 * return one point per CPU window and GPU or node, and read five minutes
 * of samples per window. A job without allocated GPUs, a job that is too
 * short and the other "not-computed" states send no query at all.
 *
 * A failing GPU utilization query rejects the promise. The memory and the
 * CPU queries fail softly: their score gets the status "failed" and the
 * rest of the scorecard stays.
 */
export async function computeJobEfficiency({
  job,
  cluster,
  nowSeconds,
  client,
}: {
  job: JobRecord;
  cluster: ClusterSummary;
  nowSeconds: number;
  client: MetricsClient;
}): Promise<JobEfficiency> {
  const settings = resolveEfficiencySettings(cluster.efficiency);
  const notComputed = (reason: NotComputedReason, extra?: { value?: number; errors?: string[] }): JobEfficiency => ({
    kind: 'not-computed',
    reason,
    settings,
    ...extra,
  });

  if (!cluster.metricsDatasourceUid) {
    return notComputed('no-datasource');
  }
  const settingsErrors = efficiencySettingsErrors(cluster.efficiency);
  if (settingsErrors.length > 0) {
    return notComputed('invalid-settings', { errors: settingsErrors });
  }
  if (job.startTime <= 0) {
    return notComputed('not-started');
  }
  if (job.gpusTotal <= 0) {
    return notComputed('no-gpus-allocated');
  }
  const window = planScoreWindow(job, nowSeconds);
  if (window.status === 'not-started') {
    return notComputed('not-started');
  }
  if (window.status === 'too-short') {
    return notComputed('too-short', { value: window.elapsedSeconds });
  }
  if (window.status === 'too-large') {
    return notComputed('too-large', { value: window.estimatedGpus });
  }

  const cpuWindows = planCpuWindows(window);
  const queries = buildEfficiencyQueries(job, cluster, settings, window, cpuWindows);
  const context: ScoreContext = { job, cluster, settings, client, queries };
  // Evaluation k (1-based) is at gridStart + k*step and looks back one step.
  const rangeStart = window.gridStart + window.step;

  const peak = await client.range(queries.gpuPeak, rangeStart, window.gridEnd, window.step);
  const mean = await client.range(queries.gpuMean, rangeStart, window.gridEnd, window.step);
  const { series, missingGpuLabel } = toGpuBucketSeries(peak, mean, window, cluster, settings);
  if (missingGpuLabel) {
    return notComputed('missing-gpu-label');
  }
  const gpu = scoreGpus({
    series,
    jobNodes: job.nodes,
    allocatedGpus: job.gpusTotal,
    bucketCount: window.buckets,
    stepSeconds: window.step,
    idleBaselinePercent: settings.idleGpuUtilizationPercent,
  });
  if (gpu.observedGpus === 0) {
    return { kind: 'no-telemetry', window, settings };
  }

  const memory = await readMemory(context, window, gpu);
  const bottleneck = await readBottleneck(context, cpuWindows, gpu);
  return { kind: 'scored', window, settings, gpu, memory, bottleneck };
}
