import { JobRecord } from '../../api/types';
import { matchesNode } from '../JobSearch/jobMetrics';
import { CompareReduce, CompareXAxis } from './model';

export type Point = [number, number];
export type InstanceSeries = Map<string, Point[]>;

export interface InstanceSeriesSet {
  mean: InstanceSeries;
  min: InstanceSeries;
  max: InstanceSeries;
}

export interface JobSeries {
  times: number[];
  mean: number[];
  min: number[];
  max: number[];
}

interface Bucket {
  sum: number;
  count: number;
  min: number;
  max: number;
}

export function jobEndTime(job: Pick<JobRecord, 'endTime'>, now: number): number {
  return job.endTime > 0 ? job.endTime : now;
}

export function sliceJobSeries(
  job: JobRecord,
  set: InstanceSeriesSet,
  mode: 'host:port' | 'hostname',
  now: number
): JobSeries | null {
  const end = jobEndTime(job, now);
  const nodeSet = new Set(job.nodes);
  const buckets = new Map<number, Bucket>();

  const visit = (series: InstanceSeries, apply: (bucket: Bucket, value: number) => void) => {
    for (const [instance, points] of series) {
      if (!matchesNode(instance, nodeSet, job.nodes, mode)) {
        continue;
      }
      for (const [ts, value] of points) {
        if (ts < job.startTime || ts > end) {
          continue;
        }
        let bucket = buckets.get(ts);
        if (!bucket) {
          bucket = { sum: 0, count: 0, min: Infinity, max: -Infinity };
          buckets.set(ts, bucket);
        }
        apply(bucket, value);
      }
    }
  };

  visit(set.mean, (b, v) => {
    b.sum += v;
    b.count += 1;
  });
  visit(set.min, (b, v) => {
    b.min = Math.min(b.min, v);
  });
  visit(set.max, (b, v) => {
    b.max = Math.max(b.max, v);
  });

  const times = [...buckets.keys()].filter((ts) => buckets.get(ts)!.count > 0).sort((a, b) => a - b);
  if (times.length === 0) {
    return null;
  }
  const mean = times.map((ts) => {
    const b = buckets.get(ts)!;
    return b.sum / b.count;
  });
  return {
    times,
    mean,
    min: times.map((ts, i) => (Number.isFinite(buckets.get(ts)!.min) ? buckets.get(ts)!.min : mean[i])),
    max: times.map((ts, i) => (Number.isFinite(buckets.get(ts)!.max) ? buckets.get(ts)!.max : mean[i])),
  };
}

export function reduceLine(series: JobSeries, reduce: CompareReduce): number[] {
  switch (reduce) {
    case 'max':
      return series.max;
    case 'min':
      return series.min;
    default:
      return series.mean;
  }
}

export function projectTimes(
  times: number[],
  job: Pick<JobRecord, 'startTime' | 'endTime'>,
  xAxis: CompareXAxis,
  now: number
): number[] {
  switch (xAxis) {
    case 'elapsed':
      return times.map((ts) => ts - job.startTime);
    case 'progress': {
      const duration = Math.max(jobEndTime(job, now) - job.startTime, 1);
      return times.map((ts) => ((ts - job.startTime) / duration) * 100);
    }
    default:
      return times;
  }
}

export function binSeries(x: number[], y: number[], lo: number, hi: number, bins: number): number[] {
  const width = (hi - lo) / bins;
  if (!(width > 0)) {
    return new Array(bins).fill(NaN);
  }
  const sums = new Array(bins).fill(0);
  const counts = new Array(bins).fill(0);
  for (let i = 0; i < x.length; i++) {
    if (x[i] < lo || x[i] > hi || !Number.isFinite(y[i])) {
      continue;
    }
    const index = Math.min(bins - 1, Math.floor((x[i] - lo) / width));
    sums[index] += y[i];
    counts[index] += 1;
  }
  return sums.map((sum, i) => (counts[i] > 0 ? sum / counts[i] : NaN));
}

export function summarize(values: number[]): { mean: number | undefined; p95: number | undefined } {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) {
    return { mean: undefined, p95: undefined };
  }
  const mean = finite.reduce((a, b) => a + b, 0) / finite.length;
  const index = Math.min(finite.length - 1, Math.ceil(0.95 * finite.length) - 1);
  return { mean, p95: finite[index] };
}

export function valueAt(x: number[], y: number[], target: number): number | undefined {
  if (x.length === 0 || target < x[0] || target > x[x.length - 1]) {
    return undefined;
  }
  let lo = 0;
  let hi = x.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (x[mid] <= target) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return target - x[lo] <= x[hi] - target ? y[lo] : y[hi];
}
