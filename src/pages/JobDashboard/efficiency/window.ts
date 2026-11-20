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
 * Upper bound on the points (GPUs x buckets) one per-GPU query returns. Long
 * jobs on many GPUs get longer buckets instead of larger responses.
 */
export const POINT_BUDGET = 24000;
/**
 * A node shared with other jobs reports more GPUs than the job allocated.
 * The response is sized for this many GPUs per node when that exceeds the
 * allocation.
 */
export const ASSUMED_GPUS_PER_NODE = 8;

export interface ScoredWindow {
  status: 'ok';
  /** True while the job has no end time; the window then ends at "now". */
  running: boolean;
  jobStart: number;
  jobEnd: number;
  /** The scored window is (gridStart, gridEnd]; gridEnd is jobEnd. */
  gridStart: number;
  gridEnd: number;
  /** Bucket length in seconds. */
  step: number;
  /** Number of buckets; bucket k (0-based) covers (gridStart + k*step, gridStart + (k+1)*step]. */
  buckets: number;
  /** Seconds at the start of the job that fit no whole bucket and are not scored. */
  skippedSeconds: number;
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
 * Chooses the scored window and its buckets. The buckets end at the job's
 * end (or at now for a running job) and never start before the job, so no
 * bucket holds samples of the job that ran on the nodes before.
 */
export function planScoreWindow(job: JobRecord, nowSeconds: number): ScoreWindow {
  if (job.startTime <= 0) {
    return { status: 'not-started' };
  }
  const running = job.endTime <= 0;
  const jobEnd = running ? nowSeconds : job.endTime;
  const elapsedSeconds = jobEnd - job.startTime;
  if (elapsedSeconds < MIN_JOB_SECONDS) {
    return { status: 'too-short', elapsedSeconds: Math.max(elapsedSeconds, 0) };
  }

  const estimatedGpus = estimateGpuSeries(job);
  if (estimatedGpus > POINT_BUDGET) {
    return { status: 'too-large', estimatedGpus };
  }
  const bucketLimit = Math.min(MAX_BUCKETS, Math.max(1, Math.floor(POINT_BUDGET / Math.max(estimatedGpus, 1))));
  const step = Math.max(MIN_STEP_SECONDS, Math.ceil(elapsedSeconds / bucketLimit));
  const buckets = Math.floor(elapsedSeconds / step);
  const gridStart = jobEnd - buckets * step;

  return {
    status: 'ok',
    running,
    jobStart: job.startTime,
    jobEnd,
    gridStart,
    gridEnd: jobEnd,
    step,
    buckets,
    skippedSeconds: gridStart - job.startTime,
  };
}

/**
 * Maps the timestamp of a range-query sample to its bucket index, or -1 when
 * it is not one of the window's evaluation times (gridStart + (k+1)*step).
 */
export function bucketIndex(window: ScoredWindow, timestamp: number): number {
  const offset = (timestamp - window.gridStart) / window.step;
  const index = Math.round(offset) - 1;
  if (index < 0 || index >= window.buckets || Math.abs(offset - Math.round(offset)) > 1e-6) {
    return -1;
  }
  return index;
}
