import { JobRecord } from '../../../api/types';

/**
 * Jobs shorter than this are not scored: with the usual 15 to 60 second
 * scrape interval they hold too few samples per GPU for "never active" to
 * mean anything, and most of their time is start-up.
 */
export const MIN_JOB_SECONDS = 300;
/** Shortest bucket. One bucket should hold at least one scrape. */
export const MIN_STEP_SECONDS = 60;
/** Most buckets per GPU, whatever the job's length. */
export const MAX_BUCKETS = 240;
/**
 * The points (GPUs x buckets) one per-GPU query should return at most. Long
 * jobs on many GPUs get longer buckets instead of larger responses.
 *
 * The number of GPU series is not known before the first query: it is
 * estimated (estimateGpuSeries). When the first response holds more series
 * than estimated, the scorecard plans again with the true number, so the
 * budget is a bound for every query after the first one.
 */
export const POINT_BUDGET = 24000;
/**
 * From this many buckets on, the bucket boundaries are multiples of the
 * bucket length. Evaluation times on that grid are the ones a range query
 * keeps when a backend aligns it for its cache (VictoriaMetrics does so
 * from 50 points on), so the samples come back for the buckets that were
 * asked for. Windows with fewer buckets stay unaligned: there the lost
 * bucket would be a large part of the job.
 */
export const ALIGN_MIN_BUCKETS = 10;
/**
 * A node shared with other jobs reports more GPUs than the job allocated.
 * The response is sized for this many GPUs per node when that exceeds the
 * allocation.
 */
export const ASSUMED_GPUS_PER_NODE = 8;

/**
 * A running job is scored up to this long before now. The newest samples
 * are still on their way (a scrape interval, plus the time the metrics
 * backend takes to make them readable), and a bucket they have not reached
 * would read as a gap in the telemetry of every GPU.
 */
export const RUNNING_JOB_LAG_SECONDS = 120;

export interface ScoredWindow {
  status: 'ok';
  /** True while the job has no end time; the window then ends shortly before "now". */
  running: boolean;
  /** How long before "now" the window of a running job ends; 0 for a job that ended. */
  runningLagSeconds: number;
  jobStart: number;
  /** The job's end time; for a running job, "now" minus runningLagSeconds. */
  jobEnd: number;
  /** The scored window is (gridStart, gridEnd], inside the job's run. */
  gridStart: number;
  gridEnd: number;
  /** Bucket length in seconds. */
  step: number;
  /** Number of buckets; bucket k (0-based) covers (gridStart + k*step, gridStart + (k+1)*step]. */
  buckets: number;
  /** Seconds at the start and at the end of the job that fit no whole bucket and are not scored. */
  skippedStartSeconds: number;
  skippedEndSeconds: number;
}

export type ScoreWindow =
  | ScoredWindow
  | { status: 'not-started' }
  | { status: 'too-short'; elapsedSeconds: number }
  | { status: 'too-large'; estimatedGpus: number };

/** The number of GPU series the job's nodes are expected to report. */
export function estimateGpuSeries(job: JobRecord): number {
  const nodes = Math.max(job.nodeCount, job.nodes.length);
  return Math.max(job.gpusTotal, nodes * ASSUMED_GPUS_PER_NODE);
}

/**
 * Chooses the scored window and its buckets. Every bucket lies inside the
 * job's run (which ends at now for a running job), so no bucket holds
 * samples of the jobs that ran on the nodes before or after.
 *
 * gpuSeries is the number of GPU series the nodes reported in an earlier
 * response, when there is one; the window is sized for it when it exceeds
 * the estimate.
 */
export function planScoreWindow(job: JobRecord, nowSeconds: number, gpuSeries = 0): ScoreWindow {
  if (job.startTime <= 0) {
    return { status: 'not-started' };
  }
  const running = job.endTime <= 0;
  // The lag never makes a running job too short to score.
  const runningLagSeconds = running ? Math.min(RUNNING_JOB_LAG_SECONDS, Math.max(0, nowSeconds - job.startTime - MIN_JOB_SECONDS)) : 0;
  const jobEnd = running ? nowSeconds - runningLagSeconds : job.endTime;
  const elapsedSeconds = jobEnd - job.startTime;
  if (elapsedSeconds < MIN_JOB_SECONDS) {
    return { status: 'too-short', elapsedSeconds: Math.max(elapsedSeconds, 0) };
  }

  const estimatedGpus = Math.max(estimateGpuSeries(job), gpuSeries);
  if (estimatedGpus > POINT_BUDGET) {
    return { status: 'too-large', estimatedGpus };
  }
  const bucketLimit = Math.min(MAX_BUCKETS, Math.max(1, Math.floor(POINT_BUDGET / Math.max(estimatedGpus, 1))));
  const step = Math.max(MIN_STEP_SECONDS, Math.ceil(elapsedSeconds / bucketLimit));
  let gridEnd = jobEnd;
  let buckets = Math.floor(elapsedSeconds / step);
  if (buckets >= ALIGN_MIN_BUCKETS) {
    gridEnd = Math.floor(jobEnd / step) * step;
    buckets = Math.floor((gridEnd - job.startTime) / step);
  }
  const gridStart = gridEnd - buckets * step;

  return {
    status: 'ok',
    running,
    runningLagSeconds,
    jobStart: job.startTime,
    jobEnd,
    gridStart,
    gridEnd,
    step,
    buckets,
    skippedStartSeconds: gridStart - job.startTime,
    skippedEndSeconds: jobEnd - gridEnd,
  };
}

/** Index of the evaluation time start + (k+1)*step among count of them, or -1 when the timestamp is none of them. */
function gridIndex(start: number, step: number, count: number, timestamp: number): number {
  const offset = (timestamp - start) / step;
  const index = Math.round(offset) - 1;
  if (index < 0 || index >= count || Math.abs(offset - Math.round(offset)) > 1e-6) {
    return -1;
  }
  return index;
}

/**
 * Maps the timestamp of a range-query sample to its bucket index, or -1 when
 * it is not one of the window's evaluation times (gridStart + (k+1)*step).
 */
export function bucketIndex(window: ScoredWindow, timestamp: number): number {
  return gridIndex(window.gridStart, window.step, window.buckets, timestamp);
}

/**
 * Length of the windows in which CPU load and GPU utilization are compared.
 * A rate over the counters of every CPU of every node is the most costly
 * read of the scorecard, so it never looks further back than this, however
 * long the job's buckets are.
 */
export const CPU_WINDOW_SECONDS = 300;

/**
 * The windows in which the CPU load is read. Window k (0-based) covers
 * (start + (k+1)*step - seconds, start + (k+1)*step].
 */
export interface CpuWindows {
  start: number;
  /** Distance between the ends of two windows; at least the window length, so windows never overlap. */
  step: number;
  count: number;
  /** Length of one window. */
  seconds: number;
  /** Share of the scored window that the windows cover. */
  coverage: number;
}

/**
 * Places the CPU windows inside the scored window, and so inside the job:
 * no window starts before the scored window does. A rate that looked back
 * past the job's start would read the CPU time of the job that ran on the
 * nodes before.
 *
 * Buckets up to five minutes long get windows that follow each other
 * without a gap. Longer buckets get one window at the end of each: a
 * sample of the bucket.
 */
export function planCpuWindows(window: ScoredWindow): CpuWindows {
  const seconds = CPU_WINDOW_SECONDS;
  const step = Math.max(seconds, window.step);
  let start = window.gridStart;
  let count = Math.floor((window.gridEnd - start) / step);
  if (count >= ALIGN_MIN_BUCKETS) {
    // Evaluation times on multiples of the step, like the buckets.
    start = Math.ceil(window.gridStart / step) * step;
    count = Math.floor((window.gridEnd - start) / step);
  }
  const span = window.gridEnd - window.gridStart;
  return { start, step, count, seconds, coverage: span > 0 ? (count * seconds) / span : 0 };
}

/** Maps the timestamp of a range-query sample to its CPU window, or -1 when it is not the end of one. */
export function cpuWindowIndex(windows: CpuWindows, timestamp: number): number {
  return gridIndex(windows.start, windows.step, windows.count, timestamp);
}
