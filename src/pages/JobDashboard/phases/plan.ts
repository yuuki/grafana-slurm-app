/**
 * Plans the window and the buckets of a job's phase segmentation.
 *
 * The bucket length follows from three bounds:
 *
 * - Physics: a bucket must hold a few scraped samples, or a rate cannot be
 *   computed and a mean is one sample. A bucket is at least four scrape
 *   intervals and at least one minute.
 * - Cost: every query returns one point per node and bucket, and that
 *   product stays under POINT_BUDGET.
 * - Size: no more than MAX_BUCKETS buckets, whatever the job's length.
 *
 * Bucket boundaries are multiples of the bucket length. A backend that
 * aligns range queries to the step (VictoriaMetrics does, for its cache)
 * then evaluates exactly the buckets that were asked for. The price is that
 * less than one bucket at each end of the run is not analysed.
 */

/** Points (nodes x buckets) that one range query may return. */
export const POINT_BUDGET = 24_000;
export const MAX_BUCKETS = 1440;
/** Fewer buckets than this give no result: there is too little to compare. */
export const MIN_BUCKETS = 5;
export const MIN_STEP_SECONDS = 60;
/** A bucket holds at least this many scrape intervals. */
export const SCRAPES_PER_BUCKET = 4;
/** Used when the scrape interval cannot be measured. */
export const FALLBACK_SCRAPE_SECONDS = 30;
/** Nothing newer than this long before now, plus two scrape intervals, is analysed. */
export const RUNNING_LAG_SECONDS = 60;

const NICE_STEPS = [60, 120, 180, 240, 300, 600, 900, 1200, 1800, 3600, 7200, 10800, 14400, 21600, 43200, 86400];

export interface PlanJob {
  startTime: number;
  /** 0 while the job runs. */
  endTime: number;
  nodeCount: number;
}

export interface PhaseWindow {
  /** Start of the first bucket and end of the last one; both are multiples of stepSec. */
  startSec: number;
  endSec: number;
  stepSec: number;
  bucketCount: number;
  /** The run that the window lies in: the job's start, and its end or the lagged now. */
  runStartSec: number;
  runEndSec: number;
  running: boolean;
  /** The scrape interval that the bucket length is based on: the slowest of the GPU, CPU and storage series. */
  scrapeSec: number;
  /** True when the scrape interval was measured, false when the fallback was used. */
  scrapeMeasured: boolean;
}

export type PlanRefusal =
  /** The job has no start time or no node. */
  | 'not-started'
  /** Even the fewest buckets would exceed the point budget. */
  | 'too-many-nodes'
  /** Fewer than MIN_BUCKETS buckets fit into the run. */
  | 'too-short';

export type PhasePlan = { window: PhaseWindow } | { refusal: PlanRefusal; stepSec?: number; maxNodes?: number };

/**
 * The point budget gives a job with the most nodes at least this many
 * buckets. Twelve, not MIN_BUCKETS: rounding the bucket length up to a usual
 * step can double it, and aligning the buckets costs one more, which leaves
 * 12 / 2 - 1 = 5. With fewer, a large job would be refused as "too short"
 * although only its node count is the cause.
 */
export const MIN_BUCKETS_AT_MAX_NODES = 12;

/** The largest node count that is analysed. Up to it, the node count alone never makes a job too short. */
export const MAX_NODES = Math.floor(POINT_BUDGET / MIN_BUCKETS_AT_MAX_NODES);

/** The smallest of the usual step lengths that is at least the given one. */
export function niceStep(seconds: number): number {
  const nice = NICE_STEPS.find((step) => step >= seconds);
  const day = NICE_STEPS[NICE_STEPS.length - 1];
  return nice ?? Math.ceil(seconds / day) * day;
}

/**
 * The end of what can be analysed: the job's end, but no later than a moment
 * whose samples are stored. Without the lag, the newest bucket of a running
 * job (or of one that ended seconds ago) would read as missing data.
 */
export function runEnd(job: PlanJob, nowSec: number, scrapeSec: number): number {
  const stored = nowSec - RUNNING_LAG_SECONDS - 2 * scrapeSec;
  return job.endTime > 0 ? Math.min(job.endTime, stored) : stored;
}

export function planWindow(job: PlanJob, nowSec: number, scrapeSec: number | null): PhasePlan {
  if (job.startTime <= 0 || job.nodeCount <= 0) {
    return { refusal: 'not-started' };
  }
  if (job.nodeCount > MAX_NODES) {
    return { refusal: 'too-many-nodes', maxNodes: MAX_NODES };
  }
  const scrape = scrapeSec ?? FALLBACK_SCRAPE_SECONDS;
  const runEndSec = runEnd(job, nowSec, scrape);
  const maxBuckets = Math.min(MAX_BUCKETS, Math.floor(POINT_BUDGET / job.nodeCount));
  const needed = Math.max(MIN_STEP_SECONDS, SCRAPES_PER_BUCKET * scrape, Math.ceil((runEndSec - job.startTime) / maxBuckets));
  const stepSec = niceStep(needed);
  const startSec = Math.ceil(job.startTime / stepSec) * stepSec;
  const endSec = Math.floor(runEndSec / stepSec) * stepSec;
  const bucketCount = Math.max(0, (endSec - startSec) / stepSec);
  if (bucketCount < MIN_BUCKETS) {
    return { refusal: 'too-short', stepSec };
  }
  return {
    window: {
      startSec,
      endSec,
      stepSec,
      bucketCount,
      runStartSec: job.startTime,
      runEndSec,
      running: job.endTime <= 0,
      scrapeSec: scrape,
      scrapeMeasured: scrapeSec !== null,
    },
  };
}

/**
 * How far back the probes look from the end of the run. Ten minutes hold
 * enough samples to measure a scrape interval of up to five minutes, and are
 * short enough that a series whose labels changed (an exporter that was
 * restarted) is rarely counted twice.
 */
export const PROBE_RANGE_SECONDS = 600;

/** The moment the probes are evaluated at: the end of the run. */
export function probeTime(job: PlanJob, nowSec: number): number {
  return Math.floor(runEnd(job, nowSec, FALLBACK_SCRAPE_SECONDS));
}

/**
 * The moments the GPU probe is evaluated at: the end of the run, its middle
 * and ten minutes after its start, each at least one probe range from the
 * others (a short job has fewer). One look at the end misses a node whose
 * GPU exporter is silent there, and with it GPUs that the job does not hold.
 */
export function gpuProbeTimes(job: PlanJob, nowSec: number): number[] {
  const end = probeTime(job, nowSec);
  const first = Math.min(end, job.startTime + PROBE_RANGE_SECONDS);
  const middle = Math.floor((first + end) / 2);
  const times: number[] = [];
  for (const time of [end, first, middle]) {
    if (times.every((other) => Math.abs(other - time) >= PROBE_RANGE_SECONDS)) {
      times.push(time);
    }
  }
  return times;
}

/** Scrape intervals that installations use; a measured interval near one of them is taken to be it. */
const COMMON_SCRAPE_SECONDS = [1, 2, 5, 10, 15, 20, 30, 60, 120, 300];
/** How far a measured interval may be from a common one and still be taken to be it. */
const SCRAPE_SNAP_TOLERANCE = 0.15;

/**
 * The scrape interval from the sample counts of the series in a probe range.
 * The series with the most samples is the one without gaps, so its count
 * gives the interval. A missed scrape or a sample more at the edge of the
 * range moves the quotient a little, so a value near a common interval is
 * snapped to it; otherwise it is rounded up. Null when no series has two
 * samples.
 */
export function scrapeIntervalFromCounts(sampleCounts: number[], rangeSeconds: number): number | null {
  const most = Math.max(0, ...sampleCounts.filter(Number.isFinite));
  if (most < 2) {
    return null;
  }
  const measured = rangeSeconds / most;
  const common = COMMON_SCRAPE_SECONDS.find((interval) => Math.abs(measured - interval) <= SCRAPE_SNAP_TOLERANCE * interval);
  return common ?? Math.max(1, Math.ceil(measured));
}
