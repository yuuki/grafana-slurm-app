import { dateMath, TimeRange } from '@grafana/data';
import { getJob, listJobs } from '../../api/slurmApi';
import { JobRecord } from '../../api/types';
import { buildListJobsParams, SearchFilters, timelineRangeFromURLParams } from '../JobSearch/model';
import { makeRelativeTimeRange } from '../JobSearch/timelineRange';
import { isGpuMetric } from './metricCatalog';
import { COMPARE_JOB_LIMIT, DEFAULT_COMPARE_RAW_FROM, DEFAULT_COMPARE_RAW_TO } from './model';

const PICK_CONCURRENCY = 6;

export function loadCompareTimeRange(params: URLSearchParams): TimeRange {
  const range = timelineRangeFromURLParams(params);
  if (range && dateMath.isValid(range.from) && dateMath.isValid(range.to)) {
    return makeRelativeTimeRange(range.from, range.to);
  }
  return makeRelativeTimeRange(DEFAULT_COMPARE_RAW_FROM, DEFAULT_COMPARE_RAW_TO);
}

export async function loadFilterJobSet(
  filters: SearchFilters,
  range: { from: number; to: number }
): Promise<{ jobs: JobRecord[]; total: number }> {
  const response = await listJobs({ ...buildListJobsParams(filters, { timeRange: range }), limit: COMPARE_JOB_LIMIT });
  return { jobs: response.jobs.slice(0, COMPARE_JOB_LIMIT), total: response.total };
}

export async function loadPickedJobs(clusterId: string, ids: string[]): Promise<{ jobs: JobRecord[]; missingIds: string[] }> {
  const targets = ids.slice(0, COMPARE_JOB_LIMIT);
  const jobs: JobRecord[] = [];
  const missingIds: string[] = [];
  for (let i = 0; i < targets.length; i += PICK_CONCURRENCY) {
    const chunk = targets.slice(i, i + PICK_CONCURRENCY);
    const settled = await Promise.allSettled(chunk.map((id) => getJob(clusterId, id)));
    settled.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') {
        jobs.push(outcome.value);
      } else {
        missingIds.push(chunk[index]);
      }
    });
  }
  return { jobs, missingIds };
}

export function finalizeJobSet(
  jobs: JobRecord[],
  { metric, baseline }: { metric: string; baseline: JobRecord | null }
): { jobs: JobRecord[]; hiddenNonGpu: number } {
  let list = jobs;
  if (baseline && !list.some((job) => String(job.jobId) === String(baseline.jobId))) {
    // Jobs arrive newest first, so the oldest job makes room for the baseline.
    list = [baseline, ...list].slice(0, COMPARE_JOB_LIMIT);
  }
  if (!isGpuMetric(metric)) {
    return { jobs: list, hiddenNonGpu: 0 };
  }
  const visible = list.filter((job) => job.gpusTotal > 0);
  return { jobs: visible, hiddenNonGpu: list.length - visible.length };
}
