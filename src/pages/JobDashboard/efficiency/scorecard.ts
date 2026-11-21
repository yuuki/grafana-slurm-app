import { ClusterSummary, JobRecord } from '../../../api/types';
import { MetricsClient, PromSample, PromSeries } from './promClient';
import { buildEfficiencyQueries, instanceToNode } from './queries';
import {
  BottleneckInput,
  BottleneckScore,
  GpuBucketSeries,
  gpuKey,
  GpuScore,
  MemoryScore,
  scoreBottleneck,
  scoreGpus,
  scoreMemory,
} from './score';
import { efficiencySettingsErrors, ResolvedEfficiencySettings, resolveEfficiencySettings } from './settings';
import { bucketIndex, planScoreWindow, ScoredWindow } from './window';

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
export const MAX_QUERIES_PER_SCORECARD = 7;

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

function toGpuMap(samples: PromSample[], cluster: ClusterSummary, settings: ResolvedEfficiencySettings): Map<string, number> {
  const map = new Map<string, number>();
  for (const sample of samples) {
    const instance = sample.metric[cluster.instanceLabel];
    const gpu = sample.metric[settings.gpuIdLabel];
    if (instance && gpu) {
      map.set(gpuKey(instance, gpu), sample.value);
    }
  }
  return map;
}

/** One value per bucket from a query that returns a single series for the whole job. */
function toBucketValues(series: PromSeries[], window: ScoredWindow): Array<number | undefined> {
  const values = new Array<number | undefined>(window.buckets).fill(undefined);
  for (const [timestamp, value] of series[0]?.values ?? []) {
    const index = bucketIndex(window, timestamp);
    if (index >= 0) {
      values[index] = value;
    }
  }
  return values;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'query failed';
}

/**
 * Computes a job's efficiency scorecard.
 *
 * Cost: at most MAX_QUERIES_PER_SCORECARD queries, sent one after another.
 * The two per-GPU range queries return GPUs x buckets points, which
 * planScoreWindow keeps under POINT_BUDGET; the per-GPU instant queries
 * return one sample per GPU; the CPU queries return one series. A job
 * without allocated GPUs, a job that is too short and the other
 * "not-computed" states send no query at all.
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

  const queries = buildEfficiencyQueries(job, cluster, settings, window);
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

  let memory: MemoryScore;
  try {
    const used = await client.instant(queries.gpuMemoryPeak, window.gridEnd);
    const free = await client.instant(queries.gpuMemoryMinFree, window.gridEnd);
    memory = scoreMemory(gpu, toGpuMap(used, cluster, settings), toGpuMap(free, cluster, settings), settings.lowGpuMemoryPercent);
  } catch (error) {
    memory = { status: 'failed', gpusWithCapacity: 0, error: errorMessage(error) };
  }

  const bottleneckInput: BottleneckInput = {
    series,
    gpuAttribution: gpu.attribution,
    bucketCount: window.buckets,
    idleBaselinePercent: settings.idleGpuUtilizationPercent,
    idleCpus: [],
    ioWaitCpus: [],
    cpuCount: [],
    allocatedCpus: job.cpusTotal ?? 0,
  };
  let bottleneck: BottleneckScore;
  if (gpu.attribution !== 'exact') {
    // Inconclusive whatever the CPUs did: no need to query them.
    bottleneck = scoreBottleneck(bottleneckInput);
  } else if (gpu.activeGpus === 0) {
    bottleneck = { ...scoreBottleneck(bottleneckInput), status: 'not-applicable', reason: 'no-active-gpu' };
  } else {
    try {
      const idle = await client.range(queries.cpuIdle, rangeStart, window.gridEnd, window.step);
      const ioWait = await client.range(queries.cpuIoWait, rangeStart, window.gridEnd, window.step);
      const count = await client.range(queries.cpuCount, rangeStart, window.gridEnd, window.step);
      bottleneck = scoreBottleneck({
        ...bottleneckInput,
        idleCpus: toBucketValues(idle, window),
        ioWaitCpus: toBucketValues(ioWait, window),
        cpuCount: toBucketValues(count, window),
      });
    } catch (error) {
      bottleneck = { ...scoreBottleneck(bottleneckInput), status: 'failed', error: errorMessage(error) };
    }
  }

  return { kind: 'scored', window, settings, gpu, memory, bottleneck };
}
