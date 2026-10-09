import { JobRecord } from '../../api/types';
import { jobKey } from '../JobSearch/model';
import { DeviationResult, DeviationScorer, medianDeviationScorer } from './deviation';
import { CompareSort, CompareViewState, OVERLAY_LINE_LIMIT, PROFILE_BINS } from './model';
import { binSeries, jobEndTime, JobSeries, projectTimes, reduceLine, summarize } from './seriesTransform';

export type CellStatus = 'loading' | 'ready' | 'no-data' | 'error';

export interface ChartLineData {
  x: number[];
  y: number[];
  band?: { min: number[]; max: number[] };
}

export interface CompareCellModel {
  key: string;
  job: JobRecord;
  status: CellStatus;
  line: ChartLineData | null;
  stats: { mean: number | undefined; p95: number | undefined; durationSec: number };
  deviation: DeviationResult | undefined;
  isBaseline: boolean;
  isRunning: boolean;
  endedAbnormally: boolean;
  excludedFromScoring: boolean;
}

export interface CompareViewModel {
  cells: CompareCellModel[];
  xDomain: [number, number];
  yDomain: [number, number] | null;
  baselineLine: ChartLineData | null;
}

export interface BuildCompareViewInput {
  jobs: JobRecord[];
  series: Map<string, JobSeries>;
  failedJobKeys: Set<string>;
  loading: boolean;
  view: CompareViewState;
  now: number;
  scorer?: DeviationScorer;
}

const ABNORMAL_END_STATES = new Set(['FAILED', 'NODE_FAIL', 'TIMEOUT', 'OUT_OF_MEMORY']);

function keepWhere<T>(values: T[], keep: boolean[]): T[] {
  return values.filter((_, i) => keep[i]);
}

function buildLine(series: JobSeries, job: JobRecord, view: CompareViewState, now: number): ChartLineData {
  let x = projectTimes(series.times, job, view.xAxis, now);
  let y = reduceLine(series, view.reduce);
  let min = series.min;
  let max = series.max;
  if (view.xAxis === 'elapsed' && view.elapsedLimitHours > 0) {
    const limit = view.elapsedLimitHours * 3600;
    const keep = x.map((value) => value <= limit);
    x = keepWhere(x, keep);
    y = keepWhere(y, keep);
    min = keepWhere(min, keep);
    max = keepWhere(max, keep);
  }
  return view.reduce === 'band' ? { x, y, band: { min, max } } : { x, y };
}

export function computeYDomain(lines: Array<ChartLineData | null>): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const line of lines) {
    if (!line) {
      continue;
    }
    for (const values of [line.y, line.band?.min ?? [], line.band?.max ?? []]) {
      for (const v of values) {
        if (Number.isFinite(v)) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
    }
  }
  if (!Number.isFinite(lo)) {
    return null;
  }
  if (lo >= 0) {
    lo = 0;
  }
  if (hi === lo) {
    hi = lo + 1;
  }
  return [lo, hi];
}

function computeXDomain(jobs: JobRecord[], view: CompareViewState, now: number): [number, number] {
  const started = jobs.filter((job) => job.startTime > 0);
  switch (view.xAxis) {
    case 'progress':
      return [0, 100];
    case 'absolute':
      if (started.length === 0) {
        return [now - 3600, now];
      }
      return [Math.min(...started.map((j) => j.startTime)), Math.max(...started.map((j) => jobEndTime(j, now)))];
    default: {
      if (view.elapsedLimitHours > 0) {
        return [0, view.elapsedLimitHours * 3600];
      }
      const longest = Math.max(0, ...started.map((j) => jobEndTime(j, now) - j.startTime));
      return [0, Math.max(longest, 1)];
    }
  }
}

function scoreCells(cells: CompareCellModel[], input: BuildCompareViewInput): Map<string, DeviationResult> {
  const { view, now, series } = input;
  // The absolute axis has no shared shape, so it is scored on elapsed time.
  const axis = view.xAxis === 'progress' ? 'progress' : 'elapsed';
  const eligible = cells.filter((c) => c.status === 'ready' && !c.excludedFromScoring);
  const hi =
    axis === 'progress'
      ? 100
      : view.elapsedLimitHours > 0
        ? view.elapsedLimitHours * 3600
        : Math.max(1, ...eligible.map((c) => c.stats.durationSec));
  const profiles = new Map<string, number[]>();
  for (const cell of eligible) {
    const s = series.get(cell.key)!;
    const x = projectTimes(s.times, cell.job, axis, now);
    profiles.set(cell.key, binSeries(x, reduceLine(s, view.reduce), 0, hi, PROFILE_BINS));
  }
  return (input.scorer ?? medianDeviationScorer)(profiles);
}

function compareOptional(a: number | undefined, b: number | undefined, direction: 1 | -1): number {
  if (a === undefined && b === undefined) {
    return 0;
  }
  if (a === undefined) {
    return 1;
  }
  if (b === undefined) {
    return -1;
  }
  return (a - b) * direction;
}

function byStartDesc(a: CompareCellModel, b: CompareCellModel): number {
  return b.job.startTime - a.job.startTime;
}

function sortCells(cells: CompareCellModel[], sort: CompareSort): CompareCellModel[] {
  const sorted = [...cells];
  switch (sort) {
    case 'deviation':
      return sorted.sort((a, b) => compareOptional(a.deviation?.score, b.deviation?.score, -1) || byStartDesc(a, b));
    case 'mean-desc':
      return sorted.sort((a, b) => compareOptional(a.stats.mean, b.stats.mean, -1) || byStartDesc(a, b));
    case 'mean-asc':
      return sorted.sort((a, b) => compareOptional(a.stats.mean, b.stats.mean, 1) || byStartDesc(a, b));
    case 'duration':
      return sorted.sort((a, b) => b.stats.durationSec - a.stats.durationSec || byStartDesc(a, b));
    case 'job-id':
      return sorted.sort((a, b) => a.job.jobId - b.job.jobId);
    default:
      return sorted.sort(byStartDesc);
  }
}

export function buildCompareView(input: BuildCompareViewInput): CompareViewModel {
  const { jobs, series, failedJobKeys, loading, view, now } = input;
  const cells: CompareCellModel[] = jobs.map((job) => {
    const key = jobKey(job.clusterId, job.jobId);
    const s = series.get(key);
    const status: CellStatus = s ? 'ready' : failedJobKeys.has(key) ? 'error' : loading ? 'loading' : 'no-data';
    const isRunning = job.endTime === 0;
    return {
      key,
      job,
      status,
      line: s ? buildLine(s, job, view, now) : null,
      stats: {
        ...summarize(s ? reduceLine(s, view.reduce) : []),
        durationSec: job.startTime > 0 ? Math.max(jobEndTime(job, now) - job.startTime, 0) : 0,
      },
      deviation: undefined,
      isBaseline: view.baselineJobId !== '' && String(job.jobId) === view.baselineJobId,
      isRunning,
      endedAbnormally: ABNORMAL_END_STATES.has(job.state),
      excludedFromScoring: view.xAxis === 'progress' && isRunning,
    };
  });

  const deviations = scoreCells(cells, input);
  for (const cell of cells) {
    cell.deviation = deviations.get(cell.key);
  }

  return {
    cells: sortCells(cells, view.sort),
    xDomain: computeXDomain(jobs, view, now),
    yDomain: view.yScale === 'shared' ? computeYDomain(cells.map((c) => c.line)) : null,
    baselineLine: cells.find((c) => c.isBaseline && c.line)?.line ?? null,
  };
}

export function selectOverlayCells(
  cells: CompareCellModel[],
  selectedJobIds: string[]
): { cells: CompareCellModel[]; truncated: boolean } {
  const ready = cells.filter((c) => c.status === 'ready');
  const pool = selectedJobIds.length > 0 ? ready.filter((c) => selectedJobIds.includes(String(c.job.jobId))) : ready;
  return { cells: pool.slice(0, OVERLAY_LINE_LIMIT), truncated: pool.length > OVERLAY_LINE_LIMIT };
}
