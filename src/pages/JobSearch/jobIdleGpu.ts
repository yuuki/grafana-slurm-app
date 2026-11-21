import { ClusterSummary, JobRecord } from '../../api/types';
import { createDatasourceClient, MetricsClient, PromSeries } from '../JobDashboard/efficiency/promClient';
import { instanceToNode } from '../JobDashboard/efficiency/queries';
import { formatSeconds, listNodes } from '../JobDashboard/efficiency/findings';
import { unscorableRun } from '../JobDashboard/efficiency/jobRun';
import { accumulateGpuTime, attributeGpus, GpuBucketCounts } from '../JobDashboard/efficiency/score';
import { efficiencyDisabled, efficiencySettingsErrors, resolveEfficiencySettings } from '../JobDashboard/efficiency/settings';
import { MIN_JOB_SECONDS, MIN_STEP_SECONDS, POINT_BUDGET } from '../JobDashboard/efficiency/window';
import { buildFilterMatcher, buildInstanceMatcher, formatLabelNameForDatasource } from '../JobDashboard/scenes/model';
import { jobKey } from './model';

/** Most buckets one batch asks for, whatever its node count. */
export const MAX_BATCH_BUCKETS = 500;
/**
 * Longest bucket a batch may use. It bounds what one batch reads: with 500
 * buckets a page may span up to 125 days. Longer buckets do not make the
 * value wrong, only weaker: it is a lower bound, and one active sample
 * marks the whole bucket active.
 */
export const MAX_BATCH_STEP_SECONDS = 6 * 3600;

/**
 * Idle GPU time of one job in the Job Search table.
 *
 * - ok: a lower bound of the job's idle GPU time. It is computed like the
 *   Idle GPU time of the job's efficiency scorecard, but from the longer
 *   buckets a page of jobs shares, and only from the buckets that lie fully
 *   inside the job.
 * - no-data: no node of the job reported a GPU in those buckets.
 * - not-scored: the job has nothing to score (see reason).
 * - not-computed: the page's batch could not score the job (see reason).
 *   This includes telemetry that cannot be matched to the job: a node of
 *   the job that reports no GPU, or fewer GPUs reporting than allocated.
 */
export type JobIdleGpu =
  | {
      status: 'ok';
      idleGpuSeconds: number;
      /** Allocated GPU time of the buckets used. */
      scoredGpuSeconds: number;
      /** The part of scoredGpuSeconds without telemetry that belongs to the job: neither idle nor active. */
      unobservedGpuSeconds: number;
      /** True on nodes that report more GPUs than the job allocated. */
      sharedNodes: boolean;
    }
  | { status: 'no-data' }
  | { status: 'not-scored'; reason: 'no-gpus' | 'not-started' | 'too-short' | 'suspended' | 'past-time-limit' }
  | {
      status: 'not-computed';
      reason:
        | 'no-datasource'
        | 'invalid-settings'
        | 'range-too-wide'
        | 'no-full-bucket'
        | 'query-failed'
        | 'nodes-without-telemetry'
        | 'fewer-gpus-than-allocated'
        | 'incomplete-telemetry';
      /** The job's nodes that report no GPU (nodes-without-telemetry). */
      nodes?: string[];
      /** Length of the page's buckets (no-full-bucket). */
      bucketSeconds?: number;
    };

interface BatchPlan {
  jobs: JobRecord[];
  nodes: string[];
  /** Bucket k (0-based) covers (gridStart + k*step, gridStart + (k+1)*step]. */
  gridStart: number;
  step: number;
  buckets: number;
}

function jobEnd(job: JobRecord, nowSeconds: number): number {
  return job.endTime > 0 ? job.endTime : nowSeconds;
}

/**
 * Chooses one bucket grid for all jobs of a page, so that nodes x buckets
 * stays under POINT_BUDGET. Returns null when that needs buckets longer
 * than MAX_BATCH_STEP_SECONDS: the page then spans too much time for its
 * number of nodes.
 */
export function planIdleGpuBatch(jobs: JobRecord[], nowSeconds: number): BatchPlan | null {
  const nodes = [...new Set(jobs.flatMap((job) => job.nodes))];
  const start = Math.min(...jobs.map((job) => job.startTime));
  const end = Math.max(...jobs.map((job) => jobEnd(job, nowSeconds)));
  const bucketLimit = Math.min(MAX_BATCH_BUCKETS, Math.floor(POINT_BUDGET / Math.max(nodes.length, 1)));
  if (bucketLimit < 2) {
    return null;
  }
  // One bucket of the limit is kept for the alignment below, which can
  // move the grid start back by up to one step.
  const step = Math.max(MIN_STEP_SECONDS, Math.ceil((end - start) / (bucketLimit - 1)));
  if (step > MAX_BATCH_STEP_SECONDS) {
    return null;
  }
  // Bucket boundaries on multiples of the step: the evaluation times a
  // backend keeps when it aligns range queries for its cache.
  const gridStart = Math.floor(start / step) * step;
  return { jobs, nodes, gridStart, step, buckets: Math.ceil((end - gridStart) / step) };
}

/** GPU counts per node and bucket from a "count by (instance)" range query. */
function toNodeCounts(series: PromSeries[], plan: BatchPlan, cluster: ClusterSummary): Map<string, number[]> {
  const counts = new Map<string, number[]>();
  for (const item of series) {
    const instance = item.metric[cluster.instanceLabel];
    if (!instance) {
      continue;
    }
    const node = instanceToNode(instance, cluster.nodeMatcherMode);
    const values = counts.get(node) ?? new Array<number>(plan.buckets).fill(0);
    for (const [timestamp, value] of item.values) {
      const index = Math.round((timestamp - plan.gridStart) / plan.step) - 1;
      if (index >= 0 && index < plan.buckets) {
        values[index] += value;
      }
    }
    counts.set(node, values);
  }
  return counts;
}

/** Indexes of the plan's buckets that lie fully inside the job. */
function fullBucketsOf(job: JobRecord, plan: BatchPlan, nowSeconds: number): number[] {
  const end = jobEnd(job, nowSeconds);
  const indexes: number[] = [];
  for (let index = 0; index < plan.buckets; index++) {
    const bucketStart = plan.gridStart + index * plan.step;
    // A bucket that crosses the job's start or end also holds samples of
    // the jobs before and after it.
    if (bucketStart >= job.startTime && bucketStart + plan.step <= end) {
      indexes.push(index);
    }
  }
  return indexes;
}

function scoreJob(
  job: JobRecord,
  plan: BatchPlan,
  observed: Map<string, number[]>,
  active: Map<string, number[]>,
  nowSeconds: number
): JobIdleGpu {
  const indexes = fullBucketsOf(job, plan, nowSeconds);
  if (indexes.length === 0) {
    return { status: 'not-computed', reason: 'no-full-bucket', bucketSeconds: plan.step };
  }
  // The GPUs of a node: the most that reported in one of the job's buckets.
  const gpusPerNode = new Map<string, number>();
  for (const node of job.nodes) {
    const counts = observed.get(node);
    gpusPerNode.set(node, counts ? indexes.reduce((highest, index) => Math.max(highest, counts[index]), 0) : 0);
  }
  const { attribution, unknownReason, silentNodes } = attributeGpus(job.nodes, gpusPerNode, job.gpusTotal);
  if (silentNodes.length === job.nodes.length) {
    return { status: 'no-data' };
  }
  if (attribution === 'unknown') {
    // The reporting GPUs cannot be matched to the job: no number is shown.
    return unknownReason === 'silent-nodes'
      ? { status: 'not-computed', reason: 'nodes-without-telemetry', nodes: silentNodes }
      : { status: 'not-computed', reason: 'fewer-gpus-than-allocated' };
  }

  const buckets: GpuBucketCounts[] = indexes.map((index) => {
    const counts = { seconds: plan.step, observed: 0, active: 0, complete: true };
    for (const node of job.nodes) {
      const reporting = observed.get(node)?.[index] ?? 0;
      counts.observed += reporting;
      counts.active += active.get(node)?.[index] ?? 0;
      counts.complete = counts.complete && reporting === gpusPerNode.get(node);
    }
    return counts;
  });
  const time = accumulateGpuTime(buckets, job.gpusTotal, attribution);
  if (time.activeSeconds + time.idleSeconds === 0) {
    // Shared nodes, and no bucket in which every GPU of these nodes reported.
    return { status: 'not-computed', reason: 'incomplete-telemetry' };
  }
  return {
    status: 'ok',
    idleGpuSeconds: time.idleSeconds,
    scoredGpuSeconds: time.allocatedSeconds,
    unobservedGpuSeconds: time.unobservedSeconds,
    sharedNodes: time.bounded,
  };
}

/** Why a job has nothing to score, or undefined when it goes into the batch. */
function notScoredReason(job: JobRecord, nowSeconds: number): Extract<JobIdleGpu, { status: 'not-scored' }>['reason'] | undefined {
  if (job.gpusTotal <= 0) {
    return 'no-gpus';
  }
  if (job.startTime <= 0 || job.nodes.length === 0) {
    return 'not-started';
  }
  const unscorable = unscorableRun(job, nowSeconds);
  if (unscorable) {
    return unscorable.reason;
  }
  return jobEnd(job, nowSeconds) - job.startTime < MIN_JOB_SECONDS ? 'too-short' : undefined;
}

/**
 * Scores the idle GPU time of a page of jobs with two queries: the GPUs
 * reporting and the GPUs above the idle baseline, per node and bucket. The
 * cost does not grow with the number of jobs, and nodes x buckets is at
 * most POINT_BUDGET points per query.
 *
 * Every job of the page gets an entry. A job that cannot be scored gets a
 * state that says why, never a zero. Only a cluster that turned job
 * efficiency off gets no entries and no queries.
 */
export async function fetchJobsIdleGpuBatch(
  jobs: JobRecord[],
  cluster: ClusterSummary,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  client: MetricsClient = createDatasourceClient(cluster.metricsDatasourceUid)
): Promise<Map<string, JobIdleGpu>> {
  const result = new Map<string, JobIdleGpu>();
  if (efficiencyDisabled(cluster.efficiency)) {
    // Turned off for the cluster: no entry, no query. The page shows no column.
    return result;
  }
  const targets: JobRecord[] = [];
  for (const job of jobs) {
    const reason = notScoredReason(job, nowSeconds);
    if (reason) {
      result.set(jobKey(job.clusterId, job.jobId), { status: 'not-scored', reason });
    } else {
      targets.push(job);
    }
  }
  if (targets.length === 0) {
    return result;
  }
  const fail = (reason: Extract<JobIdleGpu, { status: 'not-computed' }>['reason']) => {
    targets.forEach((job) => result.set(jobKey(job.clusterId, job.jobId), { status: 'not-computed', reason }));
    return result;
  };
  if (!cluster.metricsDatasourceUid) {
    return fail('no-datasource');
  }
  if (efficiencySettingsErrors(cluster.efficiency).length > 0) {
    return fail('invalid-settings');
  }
  const plan = planIdleGpuBatch(targets, nowSeconds);
  if (!plan) {
    return fail('range-too-wide');
  }

  const settings = resolveEfficiencySettings(cluster.efficiency);
  const instanceMatcher = buildInstanceMatcher(plan.nodes, cluster.instanceLabel, cluster.nodeMatcherMode, cluster.metricsType);
  const filterMatcher = buildFilterMatcher(cluster.metricsFilterLabel, cluster.metricsFilterValue, cluster.metricsType);
  const matcher = [instanceMatcher, filterMatcher].filter(Boolean).join(',');
  const byInstance = `by (${formatLabelNameForDatasource(cluster.instanceLabel, cluster.metricsType)})`;
  const peak = `max_over_time(${settings.gpuUtilizationMetric}{${matcher}}[${plan.step}s])`;
  const start = plan.gridStart + plan.step;
  const end = plan.gridStart + plan.buckets * plan.step;

  let observed: Map<string, number[]>;
  let active: Map<string, number[]>;
  try {
    observed = toNodeCounts(await client.range(`count ${byInstance} (${peak})`, start, end, plan.step), plan, cluster);
    active = toNodeCounts(
      await client.range(`count ${byInstance} (${peak} > ${settings.idleGpuUtilizationPercent})`, start, end, plan.step),
      plan,
      cluster
    );
  } catch {
    return fail('query-failed');
  }

  for (const job of targets) {
    result.set(jobKey(job.clusterId, job.jobId), scoreJob(job, plan, observed, active, nowSeconds));
  }
  return result;
}

/** Orders jobs by idle GPU time, most first; jobs without a value keep their order after them. */
export function sortJobsByIdleGpu(jobs: JobRecord[], idleGpu: Map<string, JobIdleGpu>): JobRecord[] {
  const seconds = (job: JobRecord): number => {
    const entry = idleGpu.get(jobKey(job.clusterId, job.jobId));
    return entry?.status === 'ok' ? entry.idleGpuSeconds : -1;
  };
  return jobs
    .map((job, index) => ({ job, index, value: seconds(job) }))
    .sort((left, right) => right.value - left.value || left.index - right.index)
    .map((item) => item.job);
}

const NOT_SCORED_REASONS: Record<string, string> = {
  'no-gpus': 'The job allocated no GPUs.',
  'not-started': 'The job has not started.',
  'too-short': 'The job ran for less than 5 minutes.',
  suspended: 'The job was suspended during its run, so its telemetry cannot be scored against its allocation.',
  'past-time-limit':
    'slurmdbd records the job as running long past its time limit. Its end may be missing from the accounting database, so it is not scored.',
  'no-datasource': 'The cluster has no metrics datasource.',
  'invalid-settings': "The cluster's efficiency settings are invalid.",
  'range-too-wide':
    'The jobs of this page span too many nodes or too much time to score together. Narrow the time range of the search, or open the job for its efficiency scorecard.',
  'query-failed': 'The metrics query failed.',
  'fewer-gpus-than-allocated':
    "The job's nodes report fewer GPUs than the job allocated, so the GPUs that report cannot be matched to the job.",
  'incomplete-telemetry': 'The job shares its nodes, and in no bucket did every GPU of these nodes report.',
};

function notComputedReason(entry: Extract<JobIdleGpu, { status: 'not-computed' }>): string {
  if (entry.reason === 'no-full-bucket') {
    const buckets = entry.bucketSeconds ? `${formatSeconds(entry.bucketSeconds)} buckets` : 'buckets';
    return `No bucket of this page lies fully inside the job. The jobs of a page share one grid of ${buckets}, from the earliest start to the latest end. Narrow the time range of the search, or open the job for its efficiency scorecard.`;
  }
  if (entry.reason === 'nodes-without-telemetry') {
    const nodes = entry.nodes ?? [];
    return `${listNodes(nodes)} of the job ${nodes.length === 1 ? 'reports' : 'report'} no GPU telemetry, so the GPUs that report cannot be matched to the job.`;
  }
  return NOT_SCORED_REASONS[entry.reason];
}

function hours(seconds: number): string {
  return (seconds / 3600).toFixed(1);
}

/** Text of the table cell and its explanation. */
export function describeJobIdleGpu(entry: JobIdleGpu | undefined): { text: string; title: string } {
  if (!entry) {
    return { text: '...', title: 'Scoring idle GPU time' };
  }
  switch (entry.status) {
    case 'ok': {
      const idle = hours(entry.idleGpuSeconds);
      const share = entry.scoredGpuSeconds > 0 ? Math.round((entry.idleGpuSeconds / entry.scoredGpuSeconds) * 100) : 0;
      const shared = entry.sharedNodes ? ' The job shares its nodes, so this counts only GPUs that no job used.' : '';
      const unobserved =
        entry.unobservedGpuSeconds > 0
          ? ` ${hours(entry.unobservedGpuSeconds)} GPU-hours have no telemetry that belongs to the job and count as neither idle nor active.`
          : '';
      return {
        text: `≥ ${idle}`,
        title: `At least ${idle} GPU-hours idle, ${share}% of the ${hours(entry.scoredGpuSeconds)} allocated GPU-hours scored.${shared}${unobserved}`,
      };
    }
    case 'no-data':
      return { text: 'no data', title: "No GPU telemetry for the job's nodes and time. This does not mean that the GPUs were idle." };
    case 'not-scored':
      return { text: '-', title: NOT_SCORED_REASONS[entry.reason] };
    case 'not-computed':
      return { text: 'n/c', title: `Not computed. ${notComputedReason(entry)}` };
  }
}
