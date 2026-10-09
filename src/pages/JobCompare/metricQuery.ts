import { ClusterSummary, JobRecord } from '../../api/types';
import { buildFilterMatcher, buildInstanceMatcher, formatLabelNameForDatasource } from '../JobDashboard/scenes/model';
import { PrometheusMetricType } from '../JobDashboard/scenes/metricDiscovery';
import { queryRangePerInstanceStrict } from '../JobSearch/jobMetrics';
import { jobKey } from '../JobSearch/model';
import { jobEndTime, JobSeries, sliceJobSeries } from './seriesTransform';

export const RATE_WINDOW = '5m';
export const BATCH_GAP_SECONDS = 6 * 3600;
const MAX_POINTS_PER_SERIES = 11000;
const TARGET_POINTS_PER_JOB = 200;
const MIN_STEP_SECONDS = 15;

export function buildCompareExprs(
  metricName: string,
  metricType: PrometheusMetricType,
  matcher: string,
  byLabel: string
): { mean: string; min: string; max: string } {
  const base = metricType === 'counter' ? `rate(${metricName}{${matcher}}[${RATE_WINDOW}])` : `${metricName}{${matcher}}`;
  return {
    mean: `avg by(${byLabel}) (${base})`,
    min: `min by(${byLabel}) (${base})`,
    max: `max by(${byLabel}) (${base})`,
  };
}

export interface QueryBatch {
  jobs: JobRecord[];
  start: number;
  end: number;
}

export function planQueryBatches(jobs: JobRecord[], now: number, gap = BATCH_GAP_SECONDS): QueryBatch[] {
  const sorted = jobs.filter((j) => j.nodes.length > 0 && j.startTime > 0).sort((a, b) => a.startTime - b.startTime);
  const batches: QueryBatch[] = [];
  for (const job of sorted) {
    const end = jobEndTime(job, now);
    const last = batches[batches.length - 1];
    if (last && job.startTime <= last.end + gap) {
      last.jobs.push(job);
      last.end = Math.max(last.end, end);
    } else {
      batches.push({ jobs: [job], start: job.startTime, end });
    }
  }
  return batches;
}

export function computeStep(batch: QueryBatch, now: number): number {
  const range = Math.max(batch.end - batch.start, 1);
  const shortest = Math.min(...batch.jobs.map((j) => Math.max(jobEndTime(j, now) - j.startTime, 1)));
  return Math.max(
    MIN_STEP_SECONDS,
    Math.ceil(range / MAX_POINTS_PER_SERIES),
    Math.floor(shortest / TARGET_POINTS_PER_JOB)
  );
}

export interface CompareFetchResult {
  series: Map<string, JobSeries>;
  failedJobKeys: Set<string>;
}

export async function fetchCompareSeries({
  jobs,
  cluster,
  metricName,
  metricType,
  now,
}: {
  jobs: JobRecord[];
  cluster: ClusterSummary;
  metricName: string;
  metricType: PrometheusMetricType;
  now: number;
}): Promise<CompareFetchResult> {
  const result: CompareFetchResult = { series: new Map(), failedJobKeys: new Set() };
  if (!cluster.metricsDatasourceUid) {
    jobs.forEach((job) => result.failedJobKeys.add(jobKey(job.clusterId, job.jobId)));
    return result;
  }

  const filterMatcher = buildFilterMatcher(cluster.metricsFilterLabel, cluster.metricsFilterValue, cluster.metricsType);
  const byLabel = formatLabelNameForDatasource(cluster.instanceLabel, cluster.metricsType);

  // Batches run one after another so a 48-job page never fans out into parallel heavy queries.
  for (const batch of planQueryBatches(jobs, now)) {
    const nodes = [...new Set(batch.jobs.flatMap((j) => j.nodes))];
    const instanceMatcher = buildInstanceMatcher(nodes, cluster.instanceLabel, cluster.nodeMatcherMode, cluster.metricsType);
    const matcher = [instanceMatcher, filterMatcher].filter(Boolean).join(',');
    const exprs = buildCompareExprs(metricName, metricType, matcher, byLabel);
    const step = computeStep(batch, now);
    try {
      const [mean, min, max] = await Promise.all(
        [exprs.mean, exprs.min, exprs.max].map((expr) =>
          queryRangePerInstanceStrict(cluster.metricsDatasourceUid, expr, batch.start, batch.end, step, cluster.instanceLabel)
        )
      );
      for (const job of batch.jobs) {
        const series = sliceJobSeries(job, { mean, min, max }, cluster.nodeMatcherMode, now);
        if (series) {
          result.series.set(jobKey(job.clusterId, job.jobId), series);
        }
      }
    } catch {
      batch.jobs.forEach((job) => result.failedJobKeys.add(jobKey(job.clusterId, job.jobId)));
    }
  }
  return result;
}
