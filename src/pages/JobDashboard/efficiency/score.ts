/**
 * Pure scoring of a job's telemetry against its allocation. Nothing here
 * queries or formats: scorecard.ts feeds it bucketed series, findings.ts
 * turns the scores into sentences. docs/job-efficiency.md defines every
 * score in prose; keep the two in step.
 *
 * The rule of this module: a number about idleness or a bottleneck is a
 * fact only when the telemetry provably belongs to the job and covers it.
 * A GPU, a node, a bucket or a metric without telemetry is "no telemetry",
 * never idle or wasted, and telemetry that cannot be matched to the job
 * makes a score inconclusive.
 */

import { requiredCpuWindowLead } from './window';

/** A bucket has underused GPUs when its active GPUs average below this utilization (percent). */
export const LOW_GPU_UTILIZATION_PERCENT = 50;
/** The CPUs are saturated when at least this share of the job's CPUs is busy (percent). */
export const CPU_SATURATED_PERCENT = 90;
/** I/O wait is high when at least this share of the job's CPU time waits for I/O (percent). */
export const IO_WAIT_HIGH_PERCENT = 10;
/** A bottleneck is reported when it coincides with underused GPUs in at least this share of the scored time. */
export const BOTTLENECK_TIME_SHARE = 0.25;
/** Idle GPU time is flagged when at least this share of the allocated GPU time was provably idle. */
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
 * - idle: it never did, and it has telemetry for every bucket, so "never"
 *   covers the whole scored window.
 * - partial: it did not exceed the baseline in the buckets it reported in,
 *   but it has no telemetry for some buckets. It is not counted as idle.
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
 * How the GPUs that report on the job's nodes relate to the job's GPUs.
 * slurmdbd records how many GPUs a job holds, not which ones or on which
 * node, and the exporters do not label series with the job. A node's
 * exporter is assumed to report every GPU of the node or none.
 *
 * - exact: every node of the job reports, and together they report as many
 *   GPUs as the job allocated. The job then holds every GPU of its nodes.
 * - shared: every node reports, and together they report more GPUs than the
 *   job allocated. Which of them are the job's is unknown; only bounds hold.
 * - unknown: a node of the job reports no GPU, or the nodes report fewer
 *   GPUs than the job allocated. The reporting GPUs cannot be matched to
 *   the job: the job's share of a reporting node depends on what it holds
 *   on the nodes that do not report.
 */
export type GpuAttribution = 'exact' | 'shared' | 'unknown';

/** GPU time of the scored window, split three ways; the parts add up to allocatedSeconds. */
export interface GpuTime {
  allocatedSeconds: number;
  activeSeconds: number;
  idleSeconds: number;
  /** Allocated GPU time without telemetry that belongs to the job. It is neither idle nor active. */
  unobservedSeconds: number;
  /** True when idleSeconds is a lower bound and activeSeconds an upper bound (shared nodes). */
  bounded: boolean;
}

export interface GpuBucketCounts {
  /** Length of the bucket in seconds. */
  seconds: number;
  /** GPUs with telemetry in the bucket. */
  observed: number;
  /** GPUs above the idle baseline in the bucket. */
  active: number;
  /** True when every GPU of every node of the job has telemetry in the bucket. */
  complete: boolean;
}

/**
 * Splits the allocated GPU time into active, idle and unobserved.
 *
 * With "exact" attribution every reporting GPU is the job's: reporting GPUs
 * are active or idle, the others are unobserved.
 *
 * With "shared" attribution a bucket only bounds the job, and only when it
 * is complete: at most min(allocated, active) of the job's GPUs were active,
 * so at least allocated - active were idle. In a bucket in which a node or a
 * GPU does not report, the job's GPUs may be the ones that are missing, so
 * the whole bucket is unobserved.
 */
export function accumulateGpuTime(buckets: GpuBucketCounts[], allocatedGpus: number, attribution: 'exact' | 'shared'): GpuTime {
  const time: GpuTime = { allocatedSeconds: 0, activeSeconds: 0, idleSeconds: 0, unobservedSeconds: 0, bounded: attribution === 'shared' };
  for (const bucket of buckets) {
    time.allocatedSeconds += allocatedGpus * bucket.seconds;
    if (attribution === 'exact') {
      time.activeSeconds += bucket.active * bucket.seconds;
      time.idleSeconds += (bucket.observed - bucket.active) * bucket.seconds;
      time.unobservedSeconds += (allocatedGpus - bucket.observed) * bucket.seconds;
    } else if (bucket.complete) {
      const active = Math.min(allocatedGpus, bucket.active);
      time.activeSeconds += active * bucket.seconds;
      time.idleSeconds += (allocatedGpus - active) * bucket.seconds;
    } else {
      time.unobservedSeconds += allocatedGpus * bucket.seconds;
    }
  }
  return time;
}

/**
 * Matches the GPUs that report on a job's nodes to the job's allocation.
 * gpusPerNode holds, for each node that reports, the number of its GPUs.
 */
export function attributeGpus(
  jobNodes: string[],
  gpusPerNode: Map<string, number>,
  allocatedGpus: number
): { attribution: GpuAttribution; unknownReason?: GpuScore['unknownReason']; silentNodes: string[] } {
  const silentNodes = jobNodes.filter((node) => !(gpusPerNode.get(node) ?? 0));
  if (silentNodes.length > 0) {
    return { attribution: 'unknown', unknownReason: 'silent-nodes', silentNodes };
  }
  const reporting = jobNodes.reduce((sum, node) => sum + (gpusPerNode.get(node) ?? 0), 0);
  if (reporting < allocatedGpus) {
    return { attribution: 'unknown', unknownReason: 'fewer-gpus-than-allocated', silentNodes };
  }
  return { attribution: reporting === allocatedGpus ? 'exact' : 'shared', silentNodes };
}

export interface GpuScore {
  allocatedGpus: number;
  /** GPUs with telemetry on the job's nodes anywhere in the scored window. */
  observedGpus: number;
  attribution: GpuAttribution;
  /** Why the attribution is unknown. */
  unknownReason?: 'silent-nodes' | 'fewer-gpus-than-allocated';
  /** Nodes of the job without any GPU telemetry in the scored window. */
  silentNodes: string[];
  /** Observed GPUs by activity; the three counts add up to observedGpus. */
  activeGpus: number;
  idleGpus: number;
  partialGpus: number;
  /**
   * Allocated GPUs that provably never became active. "exact": the idle
   * GPUs. "shared": the lower bound allocated - active - partial, floored
   * at 0. "unknown": 0, because nothing can be shown.
   */
  neverActiveGpus: number;
  /**
   * Most GPUs of the job active in the same bucket ("shared": an upper
   * bound). undefined unless every bucket is complete: a GPU without
   * telemetry in a bucket may have been active in it.
   */
  peakConcurrentActiveGpus: number | undefined;
  time: GpuTime;
  /** activeSeconds / (activeSeconds + idleSeconds); undefined when nothing was observed. */
  timeInUseShare: number | undefined;
  /** Mean utilization over the buckets in which a GPU was active, in percent. */
  meanUtilizationWhileActive: number | undefined;
  /** Buckets in which every GPU of every node of the job reported. */
  completeBuckets: number;
  gpus: GpuEvidence[];
}

function isActive(peak: number | undefined, idleBaselinePercent: number): boolean {
  return peak !== undefined && peak > idleBaselinePercent;
}

const evidenceCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const ACTIVITY_ORDER: Record<GpuActivity, number> = { idle: 0, partial: 1, active: 2 };

interface GpuRows {
  gpus: GpuEvidence[];
  /** GPUs reporting, and GPUs active, in each bucket. */
  observedPerBucket: number[];
  activePerBucket: number[];
  meanUtilizationWhileActive: number | undefined;
}

/** Per-bucket counts and the utilization sum of the active GPU-buckets, over all GPUs. */
interface BucketTotals {
  observedPerBucket: number[];
  activePerBucket: number[];
  activeMeanSum: number;
  activeMeanCount: number;
}

function activityOf(activeBuckets: number, observedBuckets: number, bucketCount: number): GpuActivity {
  if (activeBuckets > 0) {
    return 'active';
  }
  // "Never active" is known only with telemetry in every bucket.
  return observedBuckets === bucketCount ? 'idle' : 'partial';
}

/** One GPU's evidence row, or undefined when it never reported; adds the GPU to the totals. */
function readGpuRow(item: GpuBucketSeries, bucketCount: number, idleBaselinePercent: number, totals: BucketTotals): GpuEvidence | undefined {
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
    const mean = item.mean[bucket];
    const hasMean = mean === undefined ? 0 : 1;
    observedBuckets++;
    totals.observedPerBucket[bucket]++;
    peakUtilization = Math.max(peakUtilization, peak);
    meanSum += mean ?? 0;
    meanCount += hasMean;
    if (isActive(peak, idleBaselinePercent)) {
      activeBuckets++;
      totals.activePerBucket[bucket]++;
      totals.activeMeanSum += mean ?? 0;
      totals.activeMeanCount += hasMean;
    }
  }
  if (observedBuckets === 0) {
    return undefined;
  }
  return {
    instance: item.instance,
    node: item.node,
    gpu: item.gpu,
    activity: activityOf(activeBuckets, observedBuckets, bucketCount),
    observedBuckets,
    activeBuckets,
    peakUtilization,
    meanUtilization: meanCount > 0 ? meanSum / meanCount : undefined,
  };
}

/** Reduces each GPU's buckets to its evidence row and counts the GPUs per bucket. */
function readGpuRows(series: GpuBucketSeries[], bucketCount: number, idleBaselinePercent: number): GpuRows {
  const totals: BucketTotals = {
    observedPerBucket: new Array<number>(bucketCount).fill(0),
    activePerBucket: new Array<number>(bucketCount).fill(0),
    activeMeanSum: 0,
    activeMeanCount: 0,
  };
  const gpus: GpuEvidence[] = [];
  for (const item of series) {
    const row = readGpuRow(item, bucketCount, idleBaselinePercent, totals);
    if (row) {
      gpus.push(row);
    }
  }
  gpus.sort(
    (left, right) =>
      ACTIVITY_ORDER[left.activity] - ACTIVITY_ORDER[right.activity] ||
      evidenceCollator.compare(left.node, right.node) ||
      evidenceCollator.compare(left.gpu, right.gpu)
  );
  return {
    gpus,
    observedPerBucket: totals.observedPerBucket,
    activePerBucket: totals.activePerBucket,
    meanUtilizationWhileActive: totals.activeMeanCount > 0 ? totals.activeMeanSum / totals.activeMeanCount : undefined,
  };
}

export interface GpuScoreInput {
  series: GpuBucketSeries[];
  /** The job's nodes; series of other nodes are ignored. */
  jobNodes: string[];
  allocatedGpus: number;
  bucketCount: number;
  stepSeconds: number;
  idleBaselinePercent: number;
}

/**
 * Scores GPU activity. A GPU is active in a bucket when its highest
 * utilization sample of that bucket exceeds idleBaselinePercent; this is
 * lenient on purpose (one sample marks the whole bucket active), so idle
 * time is never overstated.
 */
export function scoreGpus(input: GpuScoreInput): GpuScore {
  const { allocatedGpus, bucketCount, stepSeconds } = input;
  const jobNodes = new Set(input.jobNodes);
  const rows = readGpuRows(
    input.series.filter((item) => jobNodes.has(item.node)),
    bucketCount,
    input.idleBaselinePercent
  );
  const { gpus } = rows;

  const gpusPerNode = new Map<string, number>();
  for (const gpu of gpus) {
    gpusPerNode.set(gpu.node, (gpusPerNode.get(gpu.node) ?? 0) + 1);
  }
  const { attribution, unknownReason, silentNodes } = attributeGpus(input.jobNodes, gpusPerNode, allocatedGpus);

  const observedGpus = gpus.length;
  const activeGpus = gpus.filter((gpu) => gpu.activity === 'active').length;
  const idleGpus = gpus.filter((gpu) => gpu.activity === 'idle').length;
  const partialGpus = observedGpus - activeGpus - idleGpus;

  const buckets = rows.observedPerBucket.map((observed, bucket) => ({
    seconds: stepSeconds,
    observed,
    active: rows.activePerBucket[bucket],
    complete: observed === observedGpus,
  }));
  const completeBuckets = attribution === 'unknown' ? 0 : buckets.filter((bucket) => bucket.complete).length;
  const allocatedSeconds = allocatedGpus * bucketCount * stepSeconds;
  const time: GpuTime =
    attribution === 'unknown'
      ? { allocatedSeconds, activeSeconds: 0, idleSeconds: 0, unobservedSeconds: allocatedSeconds, bounded: false }
      : accumulateGpuTime(buckets, allocatedGpus, attribution);
  const observedSeconds = time.activeSeconds + time.idleSeconds;

  let neverActiveGpus = 0;
  if (attribution === 'exact') {
    neverActiveGpus = idleGpus;
  } else if (attribution === 'shared') {
    neverActiveGpus = Math.max(0, allocatedGpus - activeGpus - partialGpus);
  }
  const peakActive = rows.activePerBucket.reduce((highest, count) => Math.max(highest, count), 0);

  return {
    allocatedGpus,
    observedGpus,
    attribution,
    unknownReason,
    silentNodes,
    activeGpus,
    idleGpus,
    partialGpus,
    neverActiveGpus,
    peakConcurrentActiveGpus: attribution !== 'unknown' && completeBuckets === bucketCount ? Math.min(peakActive, allocatedGpus) : undefined,
    time,
    timeInUseShare: observedSeconds > 0 ? time.activeSeconds / observedSeconds : undefined,
    meanUtilizationWhileActive: rows.meanUtilizationWhileActive,
    completeBuckets,
    gpus,
  };
}

/**
 * - low: the fullest GPU stayed below the threshold, and the memory
 *   telemetry covers every GPU in every bucket. This holds for the job even
 *   on shared nodes, where the fullest GPU may belong to another job: the
 *   job's own GPUs cannot be fuller than the fullest one.
 * - ok: the fullest GPU reached the threshold, and it is the job's.
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
  reason?: 'shared-gpus' | 'incomplete-data' | 'unattributed-gpus';
  /** The GPU with the highest share of its memory in use at its peak. */
  fullest?: { instance: string; node: string; gpu: string; peakMiB: number; capacityMiB: number; share: number };
  /** Highest memory use of any GPU in MiB, also when the capacity is unknown. */
  highestPeakMiB?: number;
  /** GPUs for which both memory use and capacity are known. */
  gpusWithCapacity: number;
  /** GPUs whose memory telemetry covers every bucket of the scored window. */
  gpusCovered: number;
  /** Message of the failed query, for status "failed". */
  error?: string;
}

/** Key of one GPU in the memory readings: instance and GPU ID. */
export function gpuKey(instance: string, gpu: string): string {
  return `${instance}\u0000${gpu}`;
}

/** One GPU's memory over the scored window. */
export interface GpuMemoryReading {
  /** Highest memory use in MiB; undefined when the use metric did not report. */
  peakUsedMiB?: number;
  /** Lowest free memory in MiB; undefined when the free metric did not report. */
  minFreeMiB?: number;
  /** Buckets in which both metrics reported. */
  coveredBuckets: number;
}

interface GpuMemoryReadings {
  fullest: MemoryScore['fullest'];
  highestPeakMiB: number | undefined;
  /** GPUs with a peak use, those of them whose capacity is known too, and those covered in every bucket. */
  gpusWithUse: number;
  gpusWithCapacity: number;
  gpusCovered: number;
}

/**
 * Adds each GPU's memory to its evidence row and finds the fullest GPU. A
 * GPU's capacity is its peak use plus its lowest free memory: at the moment
 * of the peak the free memory is at its lowest, and the two add up to what
 * the device offers.
 */
function readGpuMemory(gpus: GpuEvidence[], memory: Map<string, GpuMemoryReading>, bucketCount: number): GpuMemoryReadings {
  const readings: GpuMemoryReadings = { fullest: undefined, highestPeakMiB: undefined, gpusWithUse: 0, gpusWithCapacity: 0, gpusCovered: 0 };
  let fullestIsActive = false;
  for (const row of gpus) {
    const reading = memory.get(gpuKey(row.instance, row.gpu));
    const peak = reading?.peakUsedMiB;
    if (!reading || peak === undefined) {
      continue;
    }
    readings.gpusWithUse++;
    row.memoryPeakMiB = peak;
    readings.highestPeakMiB = Math.max(readings.highestPeakMiB ?? peak, peak);
    const capacity = peak + (reading.minFreeMiB ?? Number.NaN);
    if (!(capacity > 0)) {
      continue;
    }
    readings.gpusWithCapacity++;
    readings.gpusCovered += reading.coveredBuckets >= bucketCount ? 1 : 0;
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
export function scoreMemory(gpu: GpuScore, memory: Map<string, GpuMemoryReading>, bucketCount: number, lowMemoryPercent: number): MemoryScore {
  const { fullest, highestPeakMiB, gpusWithUse, gpusWithCapacity, gpusCovered } = readGpuMemory(gpu.gpus, memory, bucketCount);
  const base = { fullest, highestPeakMiB, gpusWithCapacity, gpusCovered };
  if (gpu.attribution === 'unknown') {
    // The reporting GPUs cannot be matched to the job, and its other GPUs do not report.
    return { ...base, status: 'inconclusive', reason: 'unattributed-gpus' };
  }
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
    // A GPU, or a bucket, without memory telemetry could hold a higher peak than the highest known one.
    const complete = gpusCovered >= gpu.observedGpus;
    return complete ? { ...base, status: 'low' } : { ...base, status: 'inconclusive', reason: 'incomplete-data' };
  }
  if (gpu.attribution === 'shared') {
    return { ...base, status: 'inconclusive', reason: 'shared-gpus' };
  }
  return { ...base, status: 'ok' };
}

/**
 * - exclusive: every node of the job reports its CPUs and the job holds all
 *   of them, so the node metrics are the job's.
 * - shared: it holds fewer; the node metrics include other jobs.
 * - unknown: the allocation records no CPU count, or more CPUs than the
 *   nodes report.
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

/** A verdict needs this many CPU windows, unless the windows cover at least MIN_CPU_WINDOW_COVERAGE of the scored window. */
export const MIN_CPU_WINDOWS = 12;
export const MIN_CPU_WINDOW_COVERAGE = 0.5;

export interface BottleneckScore {
  status: BottleneckStatus;
  /** Why the score is inconclusive or not applicable. */
  reason?:
    | 'shared-gpus'
    | 'unattributed-gpus'
    | 'no-window'
    | 'silent-cpu-nodes'
    | 'shared-cpus'
    | 'cpu-allocation-unknown'
    | 'cpu-allocation-exceeds-nodes'
    | 'cpu-telemetry-out-of-range'
    | 'too-few-windows'
    | 'incomplete-telemetry'
    | 'no-io-wait-data'
    | 'no-active-gpu';
  cpuAttribution: CpuAttribution;
  allocatedCpus: number;
  /** Logical CPUs of the job's nodes: for each node the most that reported in one window. */
  nodeCpus: number | undefined;
  /** Nodes of the job without CPU telemetry in any window. */
  silentNodes: string[];
  /** CPU windows read, and the share of the scored window they cover. */
  windows: number;
  coverage: number;
  /** Windows with complete CPU and GPU telemetry and a GPU in use: the ones a bottleneck can show in. */
  scoredWindows: number;
  /**
   * Windows in which a node, a CPU or a GPU of the job did not report, or
   * whose CPU rate may reach back before the job's start. What happened in
   * them is unknown: they count for the upper bounds below.
   */
  unscoredWindows: number;
  /** The unscored windows that begin too soon after the job's start for the scrape interval of the CPU metrics. */
  earlyWindows: number;
  /** Scored windows that also have I/O wait telemetry for every node. */
  ioScoredWindows: number;
  /** Share of the scored windows in which the GPUs in use were underused. */
  lowGpuShare: number;
  /**
   * Share of the windows (scored and unscored) with underused GPUs and
   * saturated CPUs: what is proven, and the most it can be when every
   * unscored window was such a window too.
   */
  cpuStarvedShare: number;
  cpuStarvedShareMax: number;
  /** The same for underused GPUs and high I/O wait; a window without I/O wait telemetry counts as unscored. */
  ioStarvedShare: number;
  ioStarvedShareMax: number;
  /** Means over the windows with underused GPUs; the CPU means are in CPUs. */
  meanGpuUtilizationWhileLow: number | undefined;
  meanBusyCpusWhileLow: number | undefined;
  meanIoWaitCpusWhileLow: number | undefined;
  /** Message of the failed query, for status "failed". */
  error?: string;
}

/** One node's CPU telemetry per CPU window, in CPUs; undefined marks a window without data. */
export interface NodeCpuSeries {
  node: string;
  idle: Array<number | undefined>;
  ioWait: Array<number | undefined>;
  /** CPUs with a rate in the window. */
  count: Array<number | undefined>;
  /** The fewest samples one CPU series holds in the window. */
  samples: Array<number | undefined>;
}

export interface BottleneckInput {
  gpuAttribution: GpuAttribution;
  allocatedGpus: number;
  /** For each GPU on the job's nodes, its mean utilization per CPU window. */
  gpuMeans: Array<Array<number | undefined>>;
  jobNodes: string[];
  /** CPU telemetry per node; nodes that are not the job's are ignored. */
  cpu: NodeCpuSeries[];
  windowCount: number;
  /** Length of one window, and for each window how long after the job's start it begins. */
  windowSeconds: number;
  windowLeadSeconds: number[];
  /** Share of the scored window that the CPU windows cover. */
  coverage: number;
  idleBaselinePercent: number;
  /** CPUs in the job's AllocTRES; 0 when unknown. */
  allocatedCpus: number;
}

/** The CPUs of the job's nodes and how they relate to the job's allocation. */
interface CpuScale {
  /** Each reporting node of the job with its CPU count: the most CPUs that reported in one window. */
  nodes: Array<{ series: NodeCpuSeries; cpus: number }>;
  silentNodes: string[];
  nodeCpus: number | undefined;
  attribution: CpuAttribution;
  /** Busy CPUs from which the job's CPUs count as saturated, and waiting CPUs from which I/O wait is high. */
  saturatedAt: number;
  ioHighAt: number;
}

function resolveCpuScale(input: BottleneckInput): CpuScale {
  const nodes: CpuScale['nodes'] = [];
  const silentNodes: string[] = [];
  for (const node of input.jobNodes) {
    const series = input.cpu.find((item) => item.node === node);
    const cpus = (series?.count ?? []).reduce<number>((highest, count) => Math.max(highest, count ?? 0), 0);
    if (series && cpus > 0) {
      nodes.push({ series, cpus });
    } else {
      silentNodes.push(node);
    }
  }
  const nodeCpus = nodes.length > 0 ? nodes.reduce((sum, node) => sum + node.cpus, 0) : undefined;
  let attribution: CpuAttribution = 'unknown';
  if (input.allocatedCpus > 0 && nodeCpus !== undefined && silentNodes.length === 0 && input.allocatedCpus <= nodeCpus) {
    attribution = input.allocatedCpus === nodeCpus ? 'exclusive' : 'shared';
  }
  // Without a usable CPU allocation the nodes' own CPU count stands in, and
  // the score stays inconclusive whatever the outcome.
  const jobCpus = attribution === 'unknown' ? (nodeCpus ?? 0) : input.allocatedCpus;
  return {
    nodes,
    silentNodes,
    nodeCpus,
    attribution,
    saturatedAt: (CPU_SATURATED_PERCENT / 100) * jobCpus,
    ioHighAt: (IO_WAIT_HIGH_PERCENT / 100) * jobCpus,
  };
}

/** CPU load of the job's nodes in one window, in CPUs. */
interface CpuLoad {
  busy: number;
  /** undefined when a node exports no I/O wait in the window. */
  waiting: number | undefined;
  /** False when the rates do not add up to one second per second and CPU. */
  plausible: boolean;
}

/**
 * True when the rate of a node over a window may include CPU time from
 * before the job's start. A store whose rate() also uses the last sample
 * before the window (MetricsQL) reads up to one scrape interval before
 * it; the window is safe when it begins at least that long after the
 * job's start. The scrape interval is bounded by the samples in the window.
 */
function mayReadBeforeJob(input: BottleneckInput, series: NodeCpuSeries, window: number): boolean {
  const lead = input.windowLeadSeconds[window] ?? 0;
  return lead < requiredCpuWindowLead(series.samples[window] ?? 0, input.windowSeconds);
}

/**
 * The CPU load of a window. "incomplete" when a node or one of its CPUs did
 * not report in it, "early" when its rate may reach back before the job's
 * start: the load of the job is then not known.
 */
function cpuLoadOf(input: BottleneckInput, scale: CpuScale, window: number): CpuLoad | 'incomplete' | 'early' {
  const load: CpuLoad = { busy: 0, waiting: 0, plausible: true };
  for (const { series, cpus } of scale.nodes) {
    const idle = series.idle[window];
    if (idle === undefined || series.count[window] !== cpus) {
      return 'incomplete';
    }
    if (mayReadBeforeJob(input, series, window)) {
      return 'early';
    }
    const waiting = series.ioWait[window];
    const busy = cpus - idle - (waiting ?? 0);
    // Each CPU is idle, waiting or busy for at most one second per second.
    // Anything else is not node_exporter's per-CPU counter (for example one
    // series per node), and cannot be scored.
    load.plausible = load.plausible && busy >= -CPU_TOLERANCE * cpus && idle >= 0 && (waiting ?? 0) >= 0;
    load.busy += Math.max(busy, 0);
    load.waiting = waiting === undefined || load.waiting === undefined ? undefined : load.waiting + waiting;
  }
  return load;
}

/**
 * GPU use of the job in one window: "incomplete" when a GPU of the job did
 * not report in it, otherwise the mean utilization of the GPUs in use (mean
 * above the idle baseline), or undefined when none was in use.
 */
function gpuUseOf(input: BottleneckInput, window: number): number | undefined | 'incomplete' {
  let reporting = 0;
  let inUse = 0;
  let utilizationSum = 0;
  for (const means of input.gpuMeans) {
    const mean = means[window];
    if (mean === undefined) {
      continue;
    }
    reporting++;
    if (mean > input.idleBaselinePercent) {
      inUse++;
      utilizationSum += mean;
    }
  }
  if (reporting !== input.allocatedGpus) {
    return 'incomplete';
  }
  return inUse > 0 ? utilizationSum / inUse : undefined;
}

/** Window counts and sums behind the shares and means of a BottleneckScore. */
interface BottleneckTally {
  scored: number;
  unscored: number;
  /** The unscored windows that begin too soon after the job's start. */
  early: number;
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

/** Adds a window with underused GPUs to the tally. */
function tallyLowWindow(tally: BottleneckTally, utilization: number, load: CpuLoad, scale: CpuScale): void {
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

function tallyWindows(input: BottleneckInput, scale: CpuScale): BottleneckTally {
  const tally: BottleneckTally = {
    scored: 0,
    unscored: 0,
    early: 0,
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
  for (let window = 0; window < input.windowCount; window++) {
    const load = cpuLoadOf(input, scale, window);
    const utilization = gpuUseOf(input, window);
    if (load === 'incomplete' || load === 'early' || utilization === 'incomplete') {
      tally.unscored++;
      tally.early += load === 'early' ? 1 : 0;
      continue;
    }
    if (!load.plausible) {
      tally.plausible = false;
      break;
    }
    if (utilization === undefined) {
      // Complete telemetry and no GPU in use: no GPU load to pair the CPU load with.
      continue;
    }
    tally.scored++;
    tally.ioScored += load.waiting === undefined ? 0 : 1;
    if (utilization < LOW_GPU_UTILIZATION_PERCENT) {
      tallyLowWindow(tally, utilization, load, scale);
    }
  }
  return tally;
}

/** The status of a job whose windows were tallied: who holds the CPUs and how much was read decide what the shares prove. */
function bottleneckVerdict(score: BottleneckScore, allocatedCpus: number): Pick<BottleneckScore, 'status' | 'reason'> {
  if (score.cpuAttribution === 'unknown') {
    return { status: 'inconclusive', reason: allocatedCpus > 0 ? 'cpu-allocation-exceeds-nodes' : 'cpu-allocation-unknown' };
  }
  if (score.windows < MIN_CPU_WINDOWS && score.coverage < MIN_CPU_WINDOW_COVERAGE) {
    return { status: 'inconclusive', reason: 'too-few-windows' };
  }
  const cpuBound = score.cpuStarvedShare >= BOTTLENECK_TIME_SHARE;
  const ioBound = score.ioStarvedShare >= BOTTLENECK_TIME_SHARE;
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
  // "ok" needs both bottlenecks ruled out, also for the windows without telemetry.
  if (score.cpuStarvedShareMax >= BOTTLENECK_TIME_SHARE) {
    return { status: 'inconclusive', reason: 'incomplete-telemetry' };
  }
  if (score.ioStarvedShareMax >= BOTTLENECK_TIME_SHARE) {
    return { status: 'inconclusive', reason: score.ioScoredWindows > 0 ? 'incomplete-telemetry' : 'no-io-wait-data' };
  }
  return { status: 'ok' };
}

/** Why the windows cannot be tallied at all, or undefined when they can. */
function bottleneckObstacle(input: BottleneckInput, scale: CpuScale): Pick<BottleneckScore, 'status' | 'reason'> | undefined {
  if (input.gpuAttribution !== 'exact') {
    // GPU utilization that cannot be attributed to the job cannot be paired with CPU load.
    return { status: 'inconclusive', reason: input.gpuAttribution === 'shared' ? 'shared-gpus' : 'unattributed-gpus' };
  }
  if (input.windowCount === 0) {
    return { status: 'inconclusive', reason: 'no-window' };
  }
  if (scale.nodes.length === 0) {
    return { status: 'no-data' };
  }
  if (scale.silentNodes.length > 0) {
    // The CPUs of a node that does not report may be the saturated ones.
    return { status: 'inconclusive', reason: 'silent-cpu-nodes' };
  }
  return undefined;
}

function emptyBottleneckScore(input: BottleneckInput, scale: CpuScale): BottleneckScore {
  return {
    status: 'no-data',
    cpuAttribution: scale.attribution,
    allocatedCpus: input.allocatedCpus,
    nodeCpus: scale.nodeCpus,
    silentNodes: scale.silentNodes,
    windows: input.windowCount,
    coverage: input.coverage,
    scoredWindows: 0,
    unscoredWindows: 0,
    earlyWindows: 0,
    ioScoredWindows: 0,
    lowGpuShare: 0,
    cpuStarvedShare: 0,
    cpuStarvedShareMax: 0,
    ioStarvedShare: 0,
    ioStarvedShareMax: 0,
    meanGpuUtilizationWhileLow: undefined,
    meanBusyCpusWhileLow: undefined,
    meanIoWaitCpusWhileLow: undefined,
  };
}

/** The score of a job whose CPU windows were not read: nothing to read them for, or a failed query. */
export function unreadBottleneck(input: BottleneckInput, outcome: Pick<BottleneckScore, 'status' | 'reason' | 'error'>): BottleneckScore {
  return { ...emptyBottleneckScore(input, resolveCpuScale({ ...input, cpu: [] })), silentNodes: [], ...outcome };
}

/**
 * Looks for the pattern of an input pipeline that cannot feed the GPUs: in
 * the same window the GPUs in use are underused while the job's CPUs are
 * saturated (CPU-bound) or wait for I/O (I/O-bound).
 *
 * The CPU metrics are per node. Busy CPUs are the CPUs that are neither
 * idle nor waiting for I/O; they are compared with the job's allocation as
 * a number of CPUs. On a shared node they bound the job from above: CPUs
 * that are not busy node-wide are not busy for the job either, but busy
 * ones may be another job's. A bottleneck is therefore only reported for a
 * job that holds every CPU of its nodes.
 *
 * A window counts only with telemetry of every CPU of every node and of
 * every GPU of the job. The other windows are unknown: a bottleneck is
 * reported when the windows that show it are enough on their own, and
 * ruled out when it would not be reached even if every unknown window
 * showed it.
 */
export function scoreBottleneck(input: BottleneckInput): BottleneckScore {
  const scale = resolveCpuScale(input);
  const score = emptyBottleneckScore(input, scale);
  const obstacle = bottleneckObstacle(input, scale);
  if (obstacle) {
    return { ...score, ...obstacle };
  }

  const tally = tallyWindows(input, scale);
  if (!tally.plausible) {
    return { ...score, status: 'inconclusive', reason: 'cpu-telemetry-out-of-range' };
  }
  const total = tally.scored + tally.unscored;
  if (total === 0) {
    return { ...score, status: 'not-applicable', reason: 'no-active-gpu' };
  }
  score.scoredWindows = tally.scored;
  score.unscoredWindows = tally.unscored;
  score.earlyWindows = tally.early;
  score.ioScoredWindows = tally.ioScored;
  score.lowGpuShare = tally.scored > 0 ? tally.low / tally.scored : 0;
  score.cpuStarvedShare = tally.cpuStarved / total;
  score.cpuStarvedShareMax = (tally.cpuStarved + tally.unscored) / total;
  score.ioStarvedShare = tally.ioStarved / total;
  score.ioStarvedShareMax = (tally.ioStarved + total - tally.ioScored) / total;
  if (tally.low > 0) {
    score.meanGpuUtilizationWhileLow = tally.lowUtilizationSum / tally.low;
    score.meanBusyCpusWhileLow = tally.lowBusySum / tally.low;
    score.meanIoWaitCpusWhileLow = tally.lowIoCount > 0 ? tally.lowIoSum / tally.lowIoCount : undefined;
  }
  return { ...score, ...bottleneckVerdict(score, input.allocatedCpus) };
}
