/**
 * Pure scoring of a job's telemetry against its allocation. Nothing here
 * queries or formats: scorecard.ts feeds it bucketed series, findings.ts
 * turns the scores into sentences. docs/job-efficiency.md defines every
 * score in prose; keep the two in step.
 *
 * Unknown is not zero: a GPU, a bucket or a metric without telemetry is
 * counted as "no data", never as idle or wasted.
 */

/**
 * A GPU that never became active counts as idle only when it reported in at
 * least this share of the buckets in which any GPU of the job reported. A
 * series that covers less (an exporter that came up late) says too little.
 */
export const MIN_GPU_COVERAGE = 0.5;
/** A bucket has underused GPUs when its active GPUs average below this utilization (percent). */
export const LOW_GPU_UTILIZATION_PERCENT = 50;
/** The CPUs are saturated when at least this share of the job's CPUs is busy (percent). */
export const CPU_SATURATED_PERCENT = 90;
/** I/O wait is high when at least this share of the job's CPU time waits for I/O (percent). */
export const IO_WAIT_HIGH_PERCENT = 10;
/** A bottleneck is reported when it coincides with underused GPUs in at least this share of the scored time. */
export const BOTTLENECK_TIME_SHARE = 0.25;
/** Idle GPU time is flagged when at least this share of the observed GPU time was idle. */
export const IDLE_TIME_SHARE = 0.25;
/** Slack, as a share of the CPUs, for rates that should add up to one second per second and CPU. */
const CPU_TOLERANCE = 0.05;

/** One GPU's utilization per bucket; undefined marks a bucket without samples. */
export interface GpuBucketSeries {
  /** Value of the cluster's instance label, for example "gpu-node001:9400". */
  instance: string;
  /** Slurm node name the instance belongs to. */
  node: string;
  /** Value of the GPU ID label. */
  gpu: string;
  /** Highest utilization sample of each bucket, in percent. */
  peak: Array<number | undefined>;
  /** Mean utilization of each bucket, in percent. */
  mean: Array<number | undefined>;
}

/**
 * - active: the GPU exceeded the idle baseline in at least one bucket.
 * - idle: it never did, and it reported often enough to say so.
 * - partial: it never did, but reported in too few buckets (MIN_GPU_COVERAGE).
 */
export type GpuActivity = 'active' | 'idle' | 'partial';

export interface GpuEvidence {
  instance: string;
  node: string;
  gpu: string;
  activity: GpuActivity;
  observedBuckets: number;
  activeBuckets: number;
  /** Highest utilization sample in the scored window, in percent. */
  peakUtilization: number;
  /** Mean utilization over the observed buckets, in percent; undefined without mean data. */
  meanUtilization: number | undefined;
  /** Peak memory use and capacity in MiB, when the memory metrics reported for this GPU. */
  memoryPeakMiB?: number;
  memoryCapacityMiB?: number;
}

/**
 * - exact: as many GPUs report on the job's nodes as the job allocated.
 * - shared: more GPUs report than were allocated; the telemetry cannot tell
 *   which of them belong to the job, so counts are bounds.
 * - partial: fewer GPUs report than were allocated; the rest have no data.
 */
export type GpuAttribution = 'exact' | 'shared' | 'partial';

/** GPU time of the scored window, split three ways; the parts add up to allocatedSeconds. */
export interface GpuTime {
  allocatedSeconds: number;
  activeSeconds: number;
  idleSeconds: number;
  /** Allocated GPU time without telemetry. It is neither idle nor active. */
  unobservedSeconds: number;
  /** True when idleSeconds is a lower bound and activeSeconds an upper bound (shared nodes). */
  bounded: boolean;
}

export interface GpuBucketCounts {
  /** Length of the bucket (or of its part inside the job) in seconds. */
  seconds: number;
  /** GPUs with telemetry in the bucket. */
  observed: number;
  /** GPUs above the idle baseline in the bucket. */
  active: number;
}

/**
 * Splits the allocated GPU time into active, idle and unobserved.
 *
 * A bucket in which no more GPUs report than were allocated is exact: the
 * reporting GPUs are the job's, and the missing ones are unobserved. A bucket
 * in which more GPUs report (a node shared with other jobs) only bounds the
 * job: at most min(allocated, active) of its GPUs were active, so at least
 * allocated - active were idle.
 */
export function accumulateGpuTime(buckets: GpuBucketCounts[], allocatedGpus: number): GpuTime {
  const time: GpuTime = { allocatedSeconds: 0, activeSeconds: 0, idleSeconds: 0, unobservedSeconds: 0, bounded: false };
  for (const bucket of buckets) {
    time.allocatedSeconds += allocatedGpus * bucket.seconds;
    if (bucket.observed <= allocatedGpus) {
      time.activeSeconds += bucket.active * bucket.seconds;
      time.idleSeconds += (bucket.observed - bucket.active) * bucket.seconds;
      time.unobservedSeconds += (allocatedGpus - bucket.observed) * bucket.seconds;
    } else {
      const active = Math.min(allocatedGpus, bucket.active);
      time.activeSeconds += active * bucket.seconds;
      time.idleSeconds += (allocatedGpus - active) * bucket.seconds;
      time.bounded = true;
    }
  }
  return time;
}

export interface GpuScore {
  allocatedGpus: number;
  /** GPUs with telemetry anywhere in the scored window. */
  observedGpus: number;
  attribution: GpuAttribution;
  /** Observed GPUs by activity; the three counts add up to observedGpus. */
  activeGpus: number;
  idleGpus: number;
  partialGpus: number;
  /**
   * Allocated GPUs that never became active. With "shared" attribution this
   * is the lower bound allocated - active - partial, floored at 0.
   */
  neverActiveGpus: number;
  /** Allocated GPUs without any telemetry. */
  missingGpus: number;
  /** Most GPUs active in the same bucket; with "shared" attribution an upper bound. */
  peakConcurrentActiveGpus: number;
  time: GpuTime;
  /** activeSeconds / (activeSeconds + idleSeconds); undefined when nothing was observed. */
  timeInUseShare: number | undefined;
  /** Mean utilization over the buckets in which a GPU was active, in percent. */
  meanUtilizationWhileActive: number | undefined;
  /** Buckets in which at least one GPU reported. */
  observedBuckets: number;
  gpus: GpuEvidence[];
}

function isActive(peak: number | undefined, idleBaselinePercent: number): boolean {
  return peak !== undefined && peak > idleBaselinePercent;
}

const evidenceCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const ACTIVITY_ORDER: Record<GpuActivity, number> = { idle: 0, partial: 1, active: 2 };

/**
 * Scores GPU activity. A GPU is active in a bucket when its highest
 * utilization sample of that bucket exceeds idleBaselinePercent; this is
 * lenient on purpose (one sample marks the whole bucket active), so idle
 * time is never overstated.
 */
export function scoreGpus(
  series: GpuBucketSeries[],
  allocatedGpus: number,
  bucketCount: number,
  stepSeconds: number,
  idleBaselinePercent: number
): GpuScore {
  const observedPerBucket = new Array<number>(bucketCount).fill(0);
  const activePerBucket = new Array<number>(bucketCount).fill(0);
  let activeMeanSum = 0;
  let activeMeanCount = 0;

  const rows = series
    .map((item) => {
      let observedBuckets = 0;
      let activeBuckets = 0;
      let peakUtilization = 0;
      let meanSum = 0;
      let meanCount = 0;
      for (let bucket = 0; bucket < bucketCount; bucket++) {
        const peak = item.peak[bucket];
        if (peak === undefined) {
          continue;
        }
        observedBuckets++;
        observedPerBucket[bucket]++;
        peakUtilization = Math.max(peakUtilization, peak);
        const mean = item.mean[bucket];
        if (mean !== undefined) {
          meanSum += mean;
          meanCount++;
        }
        if (isActive(peak, idleBaselinePercent)) {
          activeBuckets++;
          activePerBucket[bucket]++;
          if (mean !== undefined) {
            activeMeanSum += mean;
            activeMeanCount++;
          }
        }
      }
      return {
        instance: item.instance,
        node: item.node,
        gpu: item.gpu,
        observedBuckets,
        activeBuckets,
        peakUtilization,
        meanUtilization: meanCount > 0 ? meanSum / meanCount : undefined,
      };
    })
    .filter((row) => row.observedBuckets > 0);

  const observedBuckets = observedPerBucket.filter((count) => count > 0).length;
  const gpus: GpuEvidence[] = rows.map((row) => {
    let activity: GpuActivity = 'partial';
    if (row.activeBuckets > 0) {
      activity = 'active';
    } else if (row.observedBuckets >= MIN_GPU_COVERAGE * observedBuckets) {
      activity = 'idle';
    }
    return { ...row, activity };
  });
  gpus.sort(
    (left, right) =>
      ACTIVITY_ORDER[left.activity] - ACTIVITY_ORDER[right.activity] ||
      evidenceCollator.compare(left.node, right.node) ||
      evidenceCollator.compare(left.gpu, right.gpu)
  );

  const observedGpus = gpus.length;
  const activeGpus = gpus.filter((gpu) => gpu.activity === 'active').length;
  const idleGpus = gpus.filter((gpu) => gpu.activity === 'idle').length;
  const partialGpus = observedGpus - activeGpus - idleGpus;
  let attribution: GpuAttribution = 'exact';
  if (observedGpus > allocatedGpus) {
    attribution = 'shared';
  } else if (observedGpus < allocatedGpus) {
    attribution = 'partial';
  }

  const time = accumulateGpuTime(
    observedPerBucket.map((observed, bucket) => ({ seconds: stepSeconds, observed, active: activePerBucket[bucket] })),
    allocatedGpus
  );
  const observedSeconds = time.activeSeconds + time.idleSeconds;
  const peakActive = activePerBucket.reduce((highest, count) => Math.max(highest, count), 0);

  return {
    allocatedGpus,
    observedGpus,
    attribution,
    activeGpus,
    idleGpus,
    partialGpus,
    neverActiveGpus: attribution === 'shared' ? Math.max(0, allocatedGpus - activeGpus - partialGpus) : idleGpus,
    missingGpus: Math.max(0, allocatedGpus - observedGpus),
    peakConcurrentActiveGpus: Math.min(peakActive, allocatedGpus),
    time,
    timeInUseShare: observedSeconds > 0 ? time.activeSeconds / observedSeconds : undefined,
    meanUtilizationWhileActive: activeMeanCount > 0 ? activeMeanSum / activeMeanCount : undefined,
    observedBuckets,
    gpus,
  };
}

/**
 * - low: the fullest GPU stayed below the threshold. This holds for the job
 *   even on shared nodes, where the fullest GPU may belong to another job:
 *   the job's own GPUs cannot be fuller than the fullest one.
 * - ok: the fullest GPU reached the threshold.
 * - inconclusive: nothing can be said about the job's own GPUs.
 * - capacity-unknown: memory use reported, but not the free memory that
 *   gives the capacity.
 * - no-data: the memory metric reported nothing for the job's nodes.
 * - not-applicable: no GPU was active, so memory use says nothing.
 * - failed: the memory queries failed.
 */
export type MemoryStatus = 'low' | 'ok' | 'inconclusive' | 'capacity-unknown' | 'no-data' | 'not-applicable' | 'failed';

export interface MemoryScore {
  status: MemoryStatus;
  /** Why the score is inconclusive. */
  reason?: 'shared-gpus' | 'incomplete-data';
  /** The GPU with the highest share of its memory in use at its peak. */
  fullest?: { instance: string; node: string; gpu: string; peakMiB: number; capacityMiB: number; share: number };
  /** Highest memory use of any GPU in MiB, also when the capacity is unknown. */
  highestPeakMiB?: number;
  /** GPUs for which both memory use and capacity are known. */
  gpusWithCapacity: number;
  /** Message of the failed query, for status "failed". */
  error?: string;
}

/** Key of one GPU in the memory maps: instance and GPU ID. */
export function gpuKey(instance: string, gpu: string): string {
  return `${instance}\u0000${gpu}`;
}

interface GpuMemoryReadings {
  fullest: MemoryScore['fullest'];
  highestPeakMiB: number | undefined;
  /** GPUs with a peak use, and those of them whose capacity is known too. */
  gpusWithUse: number;
  gpusWithCapacity: number;
}

/**
 * Adds each GPU's memory to its evidence row and finds the fullest GPU. A
 * GPU's capacity is its peak use plus its lowest free memory: at the moment
 * of the peak the free memory is at its lowest, and the two add up to what
 * the device offers.
 */
function readGpuMemory(gpus: GpuEvidence[], peakUsedMiB: Map<string, number>, minFreeMiB: Map<string, number>): GpuMemoryReadings {
  const readings: GpuMemoryReadings = { fullest: undefined, highestPeakMiB: undefined, gpusWithUse: 0, gpusWithCapacity: 0 };
  let fullestIsActive = false;
  for (const row of gpus) {
    const key = gpuKey(row.instance, row.gpu);
    const peak = peakUsedMiB.get(key);
    if (peak === undefined) {
      continue;
    }
    readings.gpusWithUse++;
    row.memoryPeakMiB = peak;
    readings.highestPeakMiB = Math.max(readings.highestPeakMiB ?? peak, peak);
    const capacity = peak + (minFreeMiB.get(key) ?? Number.NaN);
    if (!(capacity > 0)) {
      continue;
    }
    readings.gpusWithCapacity++;
    row.memoryCapacityMiB = capacity;
    const share = peak / capacity;
    const isActive = row.activity === 'active';
    // Among equally full GPUs, name one that the job used.
    const fuller = !readings.fullest || share > readings.fullest.share;
    if (fuller || (share === readings.fullest?.share && isActive && !fullestIsActive)) {
      readings.fullest = { instance: row.instance, node: row.node, gpu: row.gpu, peakMiB: peak, capacityMiB: capacity, share };
      fullestIsActive = isActive;
    }
  }
  return readings;
}

/** Scores GPU memory headroom and adds each GPU's memory to its evidence row. */
export function scoreMemory(
  gpu: GpuScore,
  peakUsedMiB: Map<string, number>,
  minFreeMiB: Map<string, number>,
  lowMemoryPercent: number
): MemoryScore {
  const { fullest, highestPeakMiB, gpusWithUse, gpusWithCapacity } = readGpuMemory(gpu.gpus, peakUsedMiB, minFreeMiB);
  const base = { fullest, highestPeakMiB, gpusWithCapacity };
  if (gpu.activeGpus === 0) {
    return { ...base, status: 'not-applicable' };
  }
  if (gpusWithUse === 0) {
    return { ...base, status: 'no-data' };
  }
  if (!fullest) {
    return { ...base, status: 'capacity-unknown' };
  }
  if (fullest.share * 100 < lowMemoryPercent) {
    // A GPU without memory telemetry could be fuller than the fullest known one.
    const complete = gpusWithCapacity >= gpu.observedGpus && gpu.missingGpus === 0;
    return complete ? { ...base, status: 'low' } : { ...base, status: 'inconclusive', reason: 'incomplete-data' };
  }
  if (gpu.attribution === 'shared') {
    return { ...base, status: 'inconclusive', reason: 'shared-gpus' };
  }
  return { ...base, status: 'ok' };
}

/**
 * - exclusive: the job holds every CPU of its nodes, so the node metrics
 *   are the job's.
 * - shared: it holds fewer; the node metrics include other jobs.
 * - unknown: the allocation records no CPU count.
 */
export type CpuAttribution = 'exclusive' | 'shared' | 'unknown';

export type BottleneckStatus =
  | 'cpu-bound'
  | 'io-bound'
  | 'cpu-and-io-bound'
  | 'ok'
  | 'inconclusive'
  | 'no-data'
  | 'not-applicable'
  | 'failed';

export interface BottleneckScore {
  status: BottleneckStatus;
  /** Why the score is inconclusive or not applicable. */
  reason?: 'shared-gpus' | 'shared-cpus' | 'cpu-allocation-unknown' | 'cpu-telemetry-out-of-range' | 'no-io-wait-data' | 'no-active-gpu';
  cpuAttribution: CpuAttribution;
  allocatedCpus: number;
  /** Logical CPUs of the job's nodes: the most that reported in one bucket. */
  nodeCpus: number | undefined;
  /** Buckets with an active GPU and CPU telemetry: the time the shares refer to. */
  scoredBuckets: number;
  /** Scored buckets that also have I/O wait telemetry. */
  ioScoredBuckets: number;
  /** Share of the scored buckets in which the active GPUs were underused. */
  lowGpuShare: number;
  /** Share of the scored buckets with underused GPUs and saturated CPUs. */
  cpuStarvedShare: number;
  /** Share of the I/O-scored buckets with underused GPUs and high I/O wait. */
  ioStarvedShare: number;
  /** Means over the buckets with underused GPUs; the CPU means are in CPUs. */
  meanGpuUtilizationWhileLow: number | undefined;
  meanBusyCpusWhileLow: number | undefined;
  meanIoWaitCpusWhileLow: number | undefined;
  /** Message of the failed query, for status "failed". */
  error?: string;
}

export interface BottleneckInput {
  series: GpuBucketSeries[];
  gpuAttribution: GpuAttribution;
  bucketCount: number;
  idleBaselinePercent: number;
  /** Per bucket and summed over the job's nodes: idle CPUs, CPUs waiting for I/O, CPUs reporting. */
  idleCpus: Array<number | undefined>;
  ioWaitCpus: Array<number | undefined>;
  cpuCount: Array<number | undefined>;
  /** CPUs in the job's AllocTRES; 0 when unknown. */
  allocatedCpus: number;
}

/** The job's CPU count and how the node metrics relate to it. */
interface CpuScale {
  nodeCpus: number | undefined;
  attribution: CpuAttribution;
  /** Busy CPUs from which the job's CPUs count as saturated, and waiting CPUs from which I/O wait is high. */
  saturatedAt: number;
  ioHighAt: number;
}

function resolveCpuScale(input: BottleneckInput): CpuScale {
  const counts = input.cpuCount.filter((count): count is number => count !== undefined);
  const nodeCpus = counts.length > 0 ? Math.max(...counts) : undefined;
  let attribution: CpuAttribution = 'unknown';
  if (input.allocatedCpus > 0 && nodeCpus !== undefined) {
    attribution = input.allocatedCpus >= nodeCpus ? 'exclusive' : 'shared';
  }
  // Without a CPU allocation the node's own CPU count stands in, and the
  // score stays inconclusive whatever the outcome.
  const jobCpus = attribution === 'unknown' ? (nodeCpus ?? 0) : Math.min(input.allocatedCpus, nodeCpus ?? 0);
  return {
    nodeCpus,
    attribution,
    saturatedAt: (CPU_SATURATED_PERCENT / 100) * jobCpus,
    ioHighAt: (IO_WAIT_HIGH_PERCENT / 100) * jobCpus,
  };
}

/** CPU load of one bucket in CPUs, or undefined without CPU telemetry. */
interface CpuLoad {
  busy: number;
  /** undefined when the nodes export no I/O wait. */
  waiting: number | undefined;
  /** False when the rates do not add up to one second per second and CPU. */
  plausible: boolean;
}

function cpuLoadOf(input: BottleneckInput, bucket: number): CpuLoad | undefined {
  const cpus = input.cpuCount[bucket];
  const idle = input.idleCpus[bucket];
  if (cpus === undefined || idle === undefined) {
    return undefined;
  }
  const waiting = input.ioWaitCpus[bucket];
  const busy = cpus - idle - (waiting ?? 0);
  // Each CPU is idle, waiting or busy for at most one second per second.
  // Anything else is not node_exporter's per-CPU counter (for example one
  // series per node), and cannot be scored.
  const plausible = busy >= -CPU_TOLERANCE * cpus && idle >= 0 && (waiting ?? 0) >= 0;
  return { busy: Math.max(busy, 0), waiting, plausible };
}

/** Mean utilization of the GPUs that are active in a bucket, or undefined when none is. */
function activeGpuUtilization(series: GpuBucketSeries[], bucket: number, idleBaselinePercent: number): number | undefined {
  let activeGpus = 0;
  let utilizationSum = 0;
  for (const item of series) {
    const mean = item.mean[bucket];
    if (isActive(item.peak[bucket], idleBaselinePercent) && mean !== undefined) {
      activeGpus++;
      utilizationSum += mean;
    }
  }
  return activeGpus > 0 ? utilizationSum / activeGpus : undefined;
}

/** Bucket counts and sums behind the shares and means of a BottleneckScore. */
interface BottleneckTally {
  scored: number;
  ioScored: number;
  low: number;
  cpuStarved: number;
  ioStarved: number;
  lowUtilizationSum: number;
  lowBusySum: number;
  lowIoSum: number;
  lowIoCount: number;
  plausible: boolean;
}

function tallyBuckets(input: BottleneckInput, scale: CpuScale): BottleneckTally {
  const tally: BottleneckTally = {
    scored: 0,
    ioScored: 0,
    low: 0,
    cpuStarved: 0,
    ioStarved: 0,
    lowUtilizationSum: 0,
    lowBusySum: 0,
    lowIoSum: 0,
    lowIoCount: 0,
    plausible: true,
  };
  for (let bucket = 0; bucket < input.bucketCount; bucket++) {
    const load = cpuLoadOf(input, bucket);
    if (!load) {
      continue;
    }
    if (!load.plausible) {
      tally.plausible = false;
      break;
    }
    const utilization = activeGpuUtilization(input.series, bucket, input.idleBaselinePercent);
    if (utilization === undefined) {
      continue;
    }
    tally.scored++;
    tally.ioScored += load.waiting === undefined ? 0 : 1;
    if (utilization >= LOW_GPU_UTILIZATION_PERCENT) {
      continue;
    }
    tally.low++;
    tally.lowUtilizationSum += utilization;
    tally.lowBusySum += load.busy;
    tally.cpuStarved += load.busy >= scale.saturatedAt ? 1 : 0;
    if (load.waiting !== undefined) {
      tally.lowIoSum += load.waiting;
      tally.lowIoCount++;
      tally.ioStarved += load.waiting >= scale.ioHighAt ? 1 : 0;
    }
  }
  return tally;
}

/** The status of a job whose buckets were tallied: who holds the CPUs decides what the shares prove. */
function bottleneckVerdict(score: BottleneckScore): Pick<BottleneckScore, 'status' | 'reason'> {
  const cpuBound = score.cpuStarvedShare >= BOTTLENECK_TIME_SHARE;
  const ioBound = score.ioStarvedShare >= BOTTLENECK_TIME_SHARE;
  if (score.cpuAttribution === 'unknown') {
    return { status: 'inconclusive', reason: 'cpu-allocation-unknown' };
  }
  if (score.cpuAttribution === 'shared' && (cpuBound || ioBound)) {
    // Busy or waiting CPUs may belong to another job; idle ones clear the job.
    return { status: 'inconclusive', reason: 'shared-cpus' };
  }
  if (cpuBound) {
    return { status: ioBound ? 'cpu-and-io-bound' : 'cpu-bound' };
  }
  if (ioBound) {
    return { status: 'io-bound' };
  }
  // "ok" needs I/O wait telemetry; without it only the CPU half was checked.
  return score.ioScoredBuckets > 0 ? { status: 'ok' } : { status: 'inconclusive', reason: 'no-io-wait-data' };
}

/**
 * Looks for the pattern of an input pipeline that cannot feed the GPUs: in
 * the same bucket the active GPUs are underused while the job's CPUs are
 * saturated (CPU-bound) or wait for I/O (I/O-bound).
 *
 * The CPU metrics are per node. Busy CPUs are the CPUs that are neither
 * idle nor waiting for I/O; they are compared with the job's allocation as
 * a number of CPUs. On a shared node they bound the job from above: CPUs
 * that are not busy node-wide are not busy for the job either, but busy
 * ones may be another job's. A bottleneck is therefore only reported for a
 * job that holds every CPU of its nodes.
 */
export function scoreBottleneck(input: BottleneckInput): BottleneckScore {
  const scale = resolveCpuScale(input);
  const score: BottleneckScore = {
    status: 'no-data',
    cpuAttribution: scale.attribution,
    allocatedCpus: input.allocatedCpus,
    nodeCpus: scale.nodeCpus,
    scoredBuckets: 0,
    ioScoredBuckets: 0,
    lowGpuShare: 0,
    cpuStarvedShare: 0,
    ioStarvedShare: 0,
    meanGpuUtilizationWhileLow: undefined,
    meanBusyCpusWhileLow: undefined,
    meanIoWaitCpusWhileLow: undefined,
  };
  if (input.gpuAttribution === 'shared') {
    return { ...score, status: 'inconclusive', reason: 'shared-gpus' };
  }
  if (!scale.nodeCpus) {
    return score;
  }

  const tally = tallyBuckets(input, scale);
  if (!tally.plausible) {
    return { ...score, status: 'inconclusive', reason: 'cpu-telemetry-out-of-range' };
  }
  if (tally.scored === 0) {
    return { ...score, status: 'not-applicable', reason: 'no-active-gpu' };
  }
  score.scoredBuckets = tally.scored;
  score.ioScoredBuckets = tally.ioScored;
  score.lowGpuShare = tally.low / tally.scored;
  score.cpuStarvedShare = tally.cpuStarved / tally.scored;
  score.ioStarvedShare = tally.ioScored > 0 ? tally.ioStarved / tally.ioScored : 0;
  if (tally.low > 0) {
    score.meanGpuUtilizationWhileLow = tally.lowUtilizationSum / tally.low;
    score.meanBusyCpusWhileLow = tally.lowBusySum / tally.low;
    score.meanIoWaitCpusWhileLow = tally.lowIoCount > 0 ? tally.lowIoSum / tally.lowIoCount : undefined;
  }
  return { ...score, ...bottleneckVerdict(score) };
}
