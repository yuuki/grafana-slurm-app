import { ClusterSummary, JobRecord } from '../../../api/types';
import { unscorableRun } from './jobRun';
import { MetricsClient, PromSeries } from './promClient';
import { buildEfficiencyQueries, CPU_SAMPLES_LABEL, EfficiencyQueries, instanceToNode } from './queries';
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
import { efficiencyDisabled, efficiencySettingsErrors, ResolvedEfficiencySettings, resolveEfficiencySettings } from './settings';
import { bucketIndex, CpuWindows, cpuWindowIndex, planCpuWindows, planScoreWindow, POINT_BUDGET, ScoredWindow, ScoreWindow } from './window';

/**
 * Why a job has no scorecard. Each reason is a state of its own: none of
 * them means that the job was efficient or wasteful.
 */
export type NotComputedReason =
  | 'disabled'
  | 'no-datasource'
  | 'invalid-settings'
  | 'not-started'
  | 'no-gpus-allocated'
  | 'suspended'
  | 'past-time-limit'
  | 'too-short'
  | 'too-large'
  | 'missing-gpu-label';

export type JobEfficiency =
  | {
      kind: 'not-computed';
      reason: NotComputedReason;
      /**
       * Elapsed seconds (too-short), GPU series (too-large), seconds
       * suspended when slurmdbd records them (suspended), seconds past the
       * time limit (past-time-limit).
       */
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

/** The queries one scorecard sends; they run one after another. */
export const QUERIES_PER_SCORECARD = 8;
/**
 * The most it can send: one more when the first response shows more GPU
 * series than estimated and the first query is repeated on longer buckets.
 */
export const MAX_QUERIES_PER_SCORECARD = QUERIES_PER_SCORECARD + 1;

/** Thrown when the caller stopped waiting for the scorecard: no further query is sent. */
export class EfficiencyAborted extends Error {
  constructor() {
    super('Job efficiency scoring was cancelled');
    this.name = 'AbortError';
  }
}

/** A client that refuses to send a query once the signal is aborted. */
function stoppable(client: MetricsClient, signal: AbortSignal | undefined): MetricsClient {
  if (!signal) {
    return client;
  }
  const check = () => {
    if (signal.aborted) {
      throw new EfficiencyAborted();
    }
  };
  return {
    instant: async (expr, time) => {
      check();
      return client.instant(expr, time);
    },
    range: async (expr, start, end, step) => {
      check();
      return client.range(expr, start, end, step);
    },
  };
}

/** The message of a failed query. A cancelled scorecard is not a failed query: it stops as a whole. */
function failureOf(error: unknown): string {
  if (error instanceof EfficiencyAborted) {
    throw error;
  }
  return error instanceof Error ? error.message : 'query failed';
}

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

/**
 * Per node and CPU window: the CPUs that have a rate (two samples or more
 * in the window) and the fewest samples one CPU series holds. Each series
 * of the response counts the CPU series with one number of samples.
 */
function toNodeCpuSamples(
  series: PromSeries[],
  cluster: ClusterSummary,
  windows: CpuWindows
): Map<string, { count: Array<number | undefined>; samples: Array<number | undefined> }> {
  const byNode = new Map<string, { count: Array<number | undefined>; samples: Array<number | undefined> }>();
  for (const item of series) {
    const instance = item.metric[cluster.instanceLabel];
    const samples = Number(item.metric[CPU_SAMPLES_LABEL]);
    if (!instance || !Number.isFinite(samples)) {
      continue;
    }
    const node = instanceToNode(instance, cluster.nodeMatcherMode);
    const entry = byNode.get(node) ?? {
      count: new Array<number | undefined>(windows.count).fill(undefined),
      samples: new Array<number | undefined>(windows.count).fill(undefined),
    };
    for (const [timestamp, cpus] of item.values) {
      const index = cpuWindowIndex(windows, timestamp);
      if (index < 0 || cpus <= 0) {
        continue;
      }
      entry.samples[index] = Math.min(entry.samples[index] ?? samples, samples);
      // A series with a single sample in the window has no rate.
      entry.count[index] = (entry.count[index] ?? 0) + (samples >= 2 ? cpus : 0);
    }
    byNode.set(node, entry);
  }
  return byNode;
}

function toNodeCpuSeries(
  responses: { idle: PromSeries[]; ioWait: PromSeries[]; samples: PromSeries[] },
  cluster: ClusterSummary,
  windows: CpuWindows
): NodeCpuSeries[] {
  const idle = toNodeWindowValues(responses.idle, cluster, windows);
  const ioWait = toNodeWindowValues(responses.ioWait, cluster, windows);
  const none = new Array<number | undefined>(windows.count).fill(undefined);
  return [...toNodeCpuSamples(responses.samples, cluster, windows).entries()].map(([node, { count, samples }]) => ({
    node,
    count,
    samples,
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
    const used = await queryBuckets(client, queries.gpuMemoryPeak, window);
    const free = await queryBuckets(client, queries.gpuMemoryMinFree, window);
    return scoreMemory(gpu, toGpuMemory(used, free, window, cluster, settings), window.buckets, settings.lowGpuMemoryPercent);
  } catch (error) {
    return { status: 'failed', gpusWithCapacity: 0, gpusCovered: 0, error: failureOf(error) };
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
    windowSeconds: windows.seconds,
    windowLeadSeconds: windows.leadSeconds,
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
    const samples = await client.range(queries.cpuSamples, start, end, windows.step);
    return scoreBottleneck({
      ...input,
      gpuMeans: toGpuWindowMeans(gpuMeans, job, cluster, settings, windows),
      cpu: toNodeCpuSeries({ idle, ioWait, samples }, cluster, windows),
    });
  } catch (error) {
    return unreadBottleneck(input, { status: 'failed', error: failureOf(error) });
  }
}

interface ScorePlan {
  window: ScoredWindow;
  cpuWindows: CpuWindows;
  queries: EfficiencyQueries;
}

function planQueries(
  job: JobRecord,
  cluster: ClusterSummary,
  settings: ResolvedEfficiencySettings,
  nowSeconds: number,
  gpuSeries?: number
): ScorePlan | Exclude<ScoreWindow, ScoredWindow> {
  const window = planScoreWindow(job, nowSeconds, gpuSeries);
  if (window.status !== 'ok') {
    return window;
  }
  const cpuWindows = planCpuWindows(window);
  return { window, cpuWindows, queries: buildEfficiencyQueries(job, cluster, settings, window, cpuWindows) };
}

/** Evaluation k (1-based) of a per-bucket query is at gridStart + k*step and looks back one step. */
function queryBuckets(client: MetricsClient, expr: string, window: ScoredWindow): Promise<PromSeries[]> {
  return client.range(expr, window.gridStart + window.step, window.gridEnd, window.step);
}

/**
 * Computes a job's efficiency scorecard.
 *
 * Cost: QUERIES_PER_SCORECARD queries, sent one after another. The four
 * per-GPU range queries (utilization peak and mean, memory use and free
 * memory) return GPUs x buckets points each, and one evaluation reads the
 * samples of one bucket; the four queries of the CPU and I/O finding
 * return one point per CPU window and GPU or node, and read five minutes
 * of samples per window. A job without allocated GPUs, a job that is too
 * short and the other "not-computed" states send no query at all.
 *
 * planScoreWindow sizes the buckets for an estimated number of GPU series,
 * so that GPUs x buckets stays under POINT_BUDGET. When the first response
 * holds more series than that, the window is planned again for the true
 * number and the first query is sent once more (MAX_QUERIES_PER_SCORECARD):
 * only that first response can exceed the budget.
 *
 * A failing GPU utilization query rejects the promise. The memory and the
 * CPU queries fail softly: their score gets the status "failed" and the
 * rest of the scorecard stays. When signal is aborted, no further query is
 * sent and the promise rejects with EfficiencyAborted.
 */
export async function computeJobEfficiency({
  job,
  cluster,
  nowSeconds,
  client: rawClient,
  signal,
}: {
  job: JobRecord;
  cluster: ClusterSummary;
  nowSeconds: number;
  client: MetricsClient;
  signal?: AbortSignal;
}): Promise<JobEfficiency> {
  const client = stoppable(rawClient, signal);
  const settings = resolveEfficiencySettings(cluster.efficiency);
  const notComputed = (reason: NotComputedReason, extra?: { value?: number; errors?: string[] }): JobEfficiency => ({
    kind: 'not-computed',
    reason,
    settings,
    ...extra,
  });
  const notPlanned = (plan: Exclude<ScoreWindow, ScoredWindow>): JobEfficiency => {
    if (plan.status === 'too-short') {
      return notComputed('too-short', { value: plan.elapsedSeconds });
    }
    return plan.status === 'too-large' ? notComputed('too-large', { value: plan.estimatedGpus }) : notComputed('not-started');
  };

  if (efficiencyDisabled(cluster.efficiency)) {
    return notComputed('disabled');
  }
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
  const unscorable = unscorableRun(job, nowSeconds);
  if (unscorable) {
    // The telemetry between the job's start and end is not all the job's.
    return notComputed(unscorable.reason, { value: unscorable.reason === 'suspended' ? unscorable.suspendedSeconds : unscorable.overSeconds });
  }
  let plan = planQueries(job, cluster, settings, nowSeconds);
  if (!('queries' in plan)) {
    return notPlanned(plan);
  }

  let peak = await queryBuckets(client, plan.queries.gpuPeak, plan.window);
  if (peak.length * plan.window.buckets > POINT_BUDGET) {
    // The nodes report more GPUs than estimated. Longer buckets keep every
    // later response within the budget.
    plan = planQueries(job, cluster, settings, nowSeconds, peak.length);
    if (!('queries' in plan)) {
      return notPlanned(plan);
    }
    peak = await queryBuckets(client, plan.queries.gpuPeak, plan.window);
  }
  const { window, cpuWindows, queries } = plan;
  const mean = await queryBuckets(client, queries.gpuMean, window);
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

  const context: ScoreContext = { job, cluster, settings, client, queries };
  const memory = await readMemory(context, window, gpu);
  const bottleneck = await readBottleneck(context, cpuWindows, gpu);
  return { kind: 'scored', window, settings, gpu, memory, bottleneck };
}
