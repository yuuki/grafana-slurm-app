/**
 * Job phase segmentation: labels each bucket of a job's timeline as startup,
 * compute, checkpoint, stalled, unclassified or no data.
 *
 * The function is pure and has no dependency, so it can be tested with
 * synthetic jobs and moved to another runtime unchanged. Its rules, in the
 * order they apply, are stated in docs/job-phases.md.
 *
 * Three things are absolute: the idle test on GPU utilization (a percentage
 * means the same on every GPU model), the smallest write rate that counts as
 * a burst, and the bounds of the CPU idle test. Everything else is relative
 * to the job: the working level of its GPUs, the write rate and the CPU load
 * while it computes.
 */
import {
  GpuBasis,
  IdleRunInfo,
  NodeIdleFinding,
  PHASE_ORDER,
  PhaseEvidence,
  PhaseId,
  PhaseInput,
  PhaseResult,
  PhaseSegment,
  PhaseThresholds,
  PhaseTotal,
  ReasonTotal,
  SIGNAL_NAMES,
  SignalMatrix,
  SignalName,
  UNCLASSIFIED_REASONS,
  UnclassifiedReason,
} from './types';

/** The working level is this quantile of the node buckets with GPU activity. */
export const WORKING_LEVEL_QUANTILE = 0.9;
/** A node works in a bucket when its GPU signals reach this share of the working level. */
export const WORKING_RATIO = 0.5;
/** A working level in utilization must be at least this many times the idle threshold. */
export const MIN_WORKING_UTIL_FACTOR = 2;
/** A write burst is at least this many times the median write rate of the compute buckets, over the job's nodes. */
export const WRITE_BURST_FACTOR = 3;
/**
 * When the CPUs of an idle stretch count as idle. A stall needs CPUs that are
 * clearly idle, not CPUs that are merely less busy than during compute:
 *
 * - below CPU_NOISE_FLOOR they are idle, whatever the job did before: that is
 *   the background load of a node;
 * - at CPU_IDLE_MAX or above they are never idle;
 * - in between they are idle only below CPU_IDLE_RATIO of the job's own CPU
 *   load while it computed. A stretch at a quarter of that load or more is
 *   too near the job's working level to be called idle.
 */
export const CPU_NOISE_FLOOR = 0.01;
export const CPU_IDLE_MAX = 0.05;
export const CPU_IDLE_RATIO = 0.25;
/** The result lists at most this many idle-node findings. */
export const MAX_NODE_FINDINGS = 20;

export const DEFAULT_PHASE_THRESHOLDS: PhaseThresholds = {
  idleGpuUtilizationPercent: 5,
  stallMinSeconds: 600,
  checkpointMinWriteBytesPerSecond: 1024 * 1024,
};

const NODE_NO_DATA = 0;
const NODE_IDLE = 1;
const NODE_LOW = 2;
const NODE_WORKING = 3;

const JOB_NO_DATA = 0;
const JOB_COMPUTE = 1;
/** Every node of the job reports, and every GPU is idle. */
const JOB_IDLE_ALL = 2;
/** Every reporting node is idle, most nodes report, but not all. */
const JOB_IDLE_REPORTING = 3;
/** Most nodes are below the working level. */
const JOB_LOW = 4;
const JOB_DISAGREE = 5;
const JOB_PARTIAL = 6;

function cell(matrix: SignalMatrix | undefined, node: number, bucket: number): number {
  const row = matrix?.[node];
  return row ? row[bucket] : NaN;
}

/** Linear-interpolated quantile of the finite values; null when there is none. */
export function quantile(values: number[], q: number): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return null;
  }
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function hasFinite(matrix: SignalMatrix | undefined): boolean {
  return matrix !== undefined && matrix.some((row) => row.some(Number.isFinite));
}

function resolveGpuBasis(input: PhaseInput): GpuBasis {
  const hasPower = hasFinite(input.signals.gpuPower);
  const hasUtil = hasFinite(input.signals.gpuUtilMean) || hasFinite(input.signals.gpuUtilMax);
  if (hasPower && hasUtil) {
    return 'power+utilization';
  }
  if (hasUtil) {
    return 'utilization';
  }
  return hasPower ? 'power' : 'none';
}

interface WorkingLevel {
  basis: GpuBasis;
  /** Null when no node bucket with GPU activity has the signal. */
  powerRef: number | null;
  utilRef: number | null;
  /** False when the job's GPUs never reached a level that counts as working. */
  usable: boolean;
  /** Only power is known and it is flat, so working cannot be told from idle. */
  levelUnknown: boolean;
}

/**
 * The job's working level, taken from the node buckets that are not proven
 * idle. Leaving the idle buckets out keeps the level right for a job that
 * hangs early and is idle for most of its run.
 */
function resolveWorkingLevel(input: PhaseInput, thresholds: PhaseThresholds): WorkingLevel {
  const { gpuPower, gpuUtilMean, gpuUtilMax } = input.signals;
  const power: number[] = [];
  const util: number[] = [];
  for (let node = 0; node < input.nodeCount; node++) {
    for (let bucket = 0; bucket < input.bucketCount; bucket++) {
      if (isIdle(cell(gpuUtilMax, node, bucket), thresholds)) {
        continue;
      }
      power.push(cell(gpuPower, node, bucket));
      util.push(cell(gpuUtilMean, node, bucket));
    }
  }
  const basis = resolveGpuBasis(input);
  const powerRef = quantile(power, WORKING_LEVEL_QUANTILE);
  const utilRef = quantile(util, WORKING_LEVEL_QUANTILE);
  const utilTooLow = utilRef !== null && utilRef < MIN_WORKING_UTIL_FACTOR * thresholds.idleGpuUtilizationPercent;
  const levelUnknown = basis === 'power' && powerRef !== null && isFlat(power, powerRef);
  return {
    basis,
    powerRef,
    utilRef,
    usable: (powerRef !== null || utilRef !== null) && !utilTooLow && !levelUnknown,
    levelUnknown,
  };
}

function isFlat(power: number[], powerRef: number): boolean {
  return power.every((value) => !Number.isFinite(value) || value >= WORKING_RATIO * powerRef);
}

function isIdle(utilMax: number, thresholds: PhaseThresholds): boolean {
  return Number.isFinite(utilMax) && utilMax <= thresholds.idleGpuUtilizationPercent;
}

function reaches(value: number, reference: number | null): boolean {
  return !Number.isFinite(value) || reference === null || value >= WORKING_RATIO * reference;
}

function nodeState(power: number, utilMean: number, utilMax: number, level: WorkingLevel, thresholds: PhaseThresholds): number {
  if (!Number.isFinite(power) && !Number.isFinite(utilMean) && !Number.isFinite(utilMax)) {
    return NODE_NO_DATA;
  }
  if (isIdle(utilMax, thresholds)) {
    return NODE_IDLE;
  }
  const hasLevelSignal = Number.isFinite(power) || Number.isFinite(utilMean);
  const working = level.usable && hasLevelSignal && reaches(power, level.powerRef) && reaches(utilMean, level.utilRef);
  return working ? NODE_WORKING : NODE_LOW;
}

function classifyNodes(input: PhaseInput, level: WorkingLevel, thresholds: PhaseThresholds): Uint8Array[] {
  const { gpuPower, gpuUtilMean, gpuUtilMax } = input.signals;
  const states: Uint8Array[] = [];
  for (let node = 0; node < input.nodeCount; node++) {
    const row = new Uint8Array(input.bucketCount);
    for (let bucket = 0; bucket < input.bucketCount; bucket++) {
      row[bucket] = nodeState(
        cell(gpuPower, node, bucket),
        cell(gpuUtilMean, node, bucket),
        cell(gpuUtilMax, node, bucket),
        level,
        thresholds
      );
    }
    states.push(row);
  }
  return states;
}

/**
 * Combines the node states of one bucket. A statement about the job needs
 * more than half of its nodes; "every GPU is idle" needs all of them. Nodes
 * without telemetry count for neither side.
 */
function jobState(working: number, low: number, idle: number, nodeCount: number): number {
  const reporting = working + low + idle;
  if (reporting === 0) {
    return JOB_NO_DATA;
  }
  if (2 * working > nodeCount) {
    return JOB_COMPUTE;
  }
  if (idle === nodeCount) {
    return JOB_IDLE_ALL;
  }
  if (2 * (low + idle) > nodeCount) {
    return idle === reporting ? JOB_IDLE_REPORTING : JOB_LOW;
  }
  return 2 * reporting <= nodeCount ? JOB_PARTIAL : JOB_DISAGREE;
}

interface JobStates {
  states: Uint8Array;
  /** Per bucket, the number of nodes that work. */
  working: Uint16Array;
}

function classifyJob(nodeStates: Uint8Array[], input: PhaseInput): JobStates {
  const states = new Uint8Array(input.bucketCount);
  const working = new Uint16Array(input.bucketCount);
  for (let bucket = 0; bucket < input.bucketCount; bucket++) {
    const counts = [0, 0, 0, 0];
    for (const row of nodeStates) {
      counts[row[bucket]] += 1;
    }
    states[bucket] = jobState(counts[NODE_WORKING], counts[NODE_LOW], counts[NODE_IDLE], input.nodeCount);
    working[bucket] = counts[NODE_WORKING];
  }
  return { states, working };
}

type Reducer = 'mean' | 'sum' | 'max';

/** One value per bucket over the nodes that have a sample; NaN when none has. */
function reduceOverNodes(matrix: SignalMatrix | undefined, input: PhaseInput, reducer: Reducer): Float64Array {
  const series = new Float64Array(input.bucketCount).fill(NaN);
  if (!matrix) {
    return series;
  }
  for (let bucket = 0; bucket < input.bucketCount; bucket++) {
    let sum = 0;
    let max = -Infinity;
    let count = 0;
    for (let node = 0; node < input.nodeCount; node++) {
      const value = cell(matrix, node, bucket);
      if (Number.isFinite(value)) {
        sum += value;
        max = Math.max(max, value);
        count += 1;
      }
    }
    if (count > 0) {
      series[bucket] = reducer === 'max' ? max : reducer === 'mean' ? sum / count : sum;
    }
  }
  return series;
}

interface JobSeries {
  gpuPower: Float64Array;
  gpuUtil: Float64Array;
  cpuBusy: Float64Array;
  /** Added over the job's nodes. */
  storageWrite: Float64Array;
  /** The write rate of the node that writes most. */
  storageWriteNode: Float64Array;
  network: Float64Array;
}

function buildJobSeries(input: PhaseInput): JobSeries {
  return {
    gpuPower: reduceOverNodes(input.signals.gpuPower, input, 'mean'),
    gpuUtil: reduceOverNodes(input.signals.gpuUtilMean, input, 'mean'),
    cpuBusy: reduceOverNodes(input.signals.cpuBusy, input, 'mean'),
    storageWrite: reduceOverNodes(input.signals.storageWrite, input, 'sum'),
    storageWriteNode: reduceOverNodes(input.signals.storageWrite, input, 'max'),
    network: reduceOverNodes(input.signals.network, input, 'sum'),
  };
}

function medianWhere(series: Float64Array, jobStates: Uint8Array, state: number): number | null {
  const values: number[] = [];
  for (let bucket = 0; bucket < series.length; bucket++) {
    if (jobStates[bucket] === state) {
      values.push(series[bucket]);
    }
  }
  return quantile(values, 0.5);
}

function medianOfRun(series: Float64Array, from: number, to: number): number | null {
  return quantile(Array.from(series.subarray(from, to)), 0.5);
}

interface Labels {
  labels: PhaseId[];
  reasons: Array<UnclassifiedReason | undefined>;
  /** For the buckets of an idle run of the stall time: what was seen in that run. */
  idleRuns: Array<IdleRunInfo | undefined>;
}

interface LabelContext {
  input: PhaseInput;
  jobStates: Uint8Array;
  firstCompute: number;
  storageWrite: Float64Array;
  storageWriteNode: Float64Array;
  /** A write burst needs this rate over the job's nodes (relative to the compute buckets) ... */
  writeBurst: number;
  /** ... and this rate on at least one node (the configured floor). */
  writeBurstNode: number;
  levelUnknown: boolean;
  /** Below this CPU load the CPUs of an idle stretch are idle. */
  cpuIdleLimit: number;
  stepSec: number;
  thresholds: PhaseThresholds;
}

function isIdleState(state: number): boolean {
  return state === JOB_IDLE_ALL || state === JOB_IDLE_REPORTING;
}

/**
 * Whether the storage write rate of a bucket is a burst: undefined when the
 * rate is unknown. A burst is clear on both scales: one node writes at the
 * configured floor or more (64 nodes that each write a few KiB/s of logs
 * are not a checkpoint, however much that is together), and the job's nodes
 * together write WRITE_BURST_FACTOR times what they wrote while computing.
 */
function isWriteBurst(bucket: number, context: LabelContext): boolean | undefined {
  const total = context.storageWrite[bucket];
  const node = context.storageWriteNode[bucket];
  if (!Number.isFinite(total) || !Number.isFinite(node)) {
    return undefined;
  }
  return node >= context.writeBurstNode && total >= context.writeBurst;
}

/**
 * The label of a bucket after the first compute in which most nodes are below
 * the working level: a checkpoint when the storage write rate shows a burst.
 * An idle run that lasts for the stall time is decided as a whole afterwards
 * (resolveIdleRun) and does not keep this label.
 */
function labelDip(bucket: number, context: LabelContext): [PhaseId, UnclassifiedReason | undefined] {
  const burst = isWriteBurst(bucket, context);
  if (burst === undefined) {
    return ['unclassified', 'gpu-low-write-unknown'];
  }
  if (burst) {
    return ['checkpoint', undefined];
  }
  return ['unclassified', isIdleState(context.jobStates[bucket]) ? 'gpu-idle-short' : 'gpu-low'];
}

function labelBucket(bucket: number, context: LabelContext): [PhaseId, UnclassifiedReason | undefined] {
  const state = context.jobStates[bucket];
  if (state === JOB_NO_DATA) {
    return ['no-data', undefined];
  }
  if (state === JOB_COMPUTE) {
    return ['compute', undefined];
  }
  if (state === JOB_DISAGREE) {
    return ['unclassified', 'nodes-disagree'];
  }
  if (state === JOB_PARTIAL) {
    return ['unclassified', 'partial-telemetry'];
  }
  if (context.firstCompute < 0) {
    return ['unclassified', context.levelUnknown ? 'gpu-level-unknown' : 'no-compute'];
  }
  return bucket < context.firstCompute ? ['init', undefined] : labelDip(bucket, context);
}

/**
 * The CPU load of the busiest node in a run of buckets: per node the median
 * over the run, then the highest of the nodes. Null when no node has a CPU
 * value in at least half of the buckets: a stall is not concluded from CPU
 * telemetry that is missing.
 *
 * The busiest node, not the mean of the nodes: work on one node of many
 * (the first rank that post-processes) keeps that node busy and leaves the
 * mean near zero. The median per node first, so that a short burst on a
 * different node in every bucket (a health check) does not add up to "busy".
 */
function busiestNodeCpu(from: number, to: number, input: PhaseInput): number | null {
  let busiest: number | null = null;
  for (let node = 0; node < input.nodeCount; node++) {
    const values: number[] = [];
    for (let bucket = from; bucket < to; bucket++) {
      const value = cell(input.signals.cpuBusy, node, bucket);
      if (Number.isFinite(value)) {
        values.push(value);
      }
    }
    const median = quantile(values, 0.5);
    if (median !== null && 2 * values.length >= to - from) {
      busiest = busiest === null ? median : Math.max(busiest, median);
    }
  }
  return busiest;
}

/** What was seen in an idle run of the stall time; every stretch of the run carries it. */
function describeIdleRun(from: number, to: number, context: LabelContext): IdleRunInfo {
  let known = 0;
  let bursts = 0;
  for (let bucket = from; bucket < to; bucket++) {
    const burst = isWriteBurst(bucket, context);
    known += burst === undefined ? 0 : 1;
    bursts += burst ? 1 : 0;
  }
  return {
    fromSec: context.input.startSec + from * context.stepSec,
    toSec: context.input.startSec + to * context.stepSec,
    bucketCount: to - from,
    writeBurstBuckets: known > 0 ? bursts : null,
    storageWriteBytesPerSecond: medianOfRun(context.storageWrite, from, to),
    cpuBusiestNode: busiestNodeCpu(from, to, context.input),
  };
}

/**
 * Decides a run of idle buckets after the job computed. The run is found from
 * the GPUs alone, so a write inside it neither splits it nor hides it.
 *
 * A run shorter than the stall time keeps its bucket labels (a dip: a
 * checkpoint where the write rate shows a burst). A run of the stall time is
 * decided as a whole, first by the CPUs:
 *
 * - CPUs idle on every node: stalled, whatever the disks do. Every GPU and
 *   every CPU idle for that long is what "stalled" names. The writes of the
 *   job and the writes of anything else on the node cannot be told apart,
 *   and a version that called such a run a checkpoint when most of its
 *   buckets had writes hid real hangs behind an error log of 2 MiB/s.
 * - CPUs not idle, and a write burst in more than half of the buckets:
 *   checkpoint / storage I/O. Something works and writes. No stall is lost
 *   by this label: with busy CPUs the run is not a stall anyway.
 * - CPUs not idle otherwise, or unknown: unclassified, with the reason.
 *
 * Every stretch of the run carries what was seen (IdleRunInfo), so the page
 * states the idle time and the writes whatever the label. A bucket is
 * labelled stalled only when every node reported in it.
 */
function resolveIdleRun(from: number, to: number, labels: Labels, context: LabelContext): void {
  if ((to - from) * context.stepSec < context.thresholds.stallMinSeconds) {
    return;
  }
  const run = describeIdleRun(from, to, context);
  const cpuBusy = run.cpuBusiestNode !== null && run.cpuBusiestNode >= context.cpuIdleLimit;
  const writing = run.writeBurstBuckets !== null && 2 * run.writeBurstBuckets > run.bucketCount;
  for (let bucket = from; bucket < to; bucket++) {
    let label: PhaseId = 'unclassified';
    let reason: UnclassifiedReason | undefined;
    if (cpuBusy && writing) {
      label = 'checkpoint';
    } else if (context.jobStates[bucket] === JOB_IDLE_REPORTING) {
      reason = 'gpu-idle-partial-telemetry';
    } else if (run.cpuBusiestNode === null) {
      reason = 'gpu-idle-cpu-unknown';
    } else if (cpuBusy) {
      reason = 'gpu-idle-cpu-busy';
    } else {
      label = 'stalled';
    }
    labels.labels[bucket] = label;
    labels.reasons[bucket] = reason;
    labels.idleRuns[bucket] = run;
  }
}

function resolveStalls(labels: Labels, context: LabelContext): void {
  if (context.firstCompute < 0) {
    return;
  }
  let runStart = -1;
  for (let bucket = context.firstCompute; bucket <= labels.labels.length; bucket++) {
    const idle = bucket < labels.labels.length && isIdleState(context.jobStates[bucket]);
    if (idle && runStart < 0) {
      runStart = bucket;
    } else if (!idle && runStart >= 0) {
      resolveIdleRun(runStart, bucket, labels, context);
      runStart = -1;
    }
  }
}

function buildSegments(labels: Labels, input: PhaseInput): PhaseSegment[] {
  const segments: PhaseSegment[] = [];
  for (let bucket = 0; bucket < input.bucketCount; bucket++) {
    const last = segments[segments.length - 1];
    const toSec = input.startSec + (bucket + 1) * input.stepSec;
    if (last && last.phase === labels.labels[bucket] && last.reason === labels.reasons[bucket]) {
      last.toSec = toSec;
      continue;
    }
    const segment: PhaseSegment = { phase: labels.labels[bucket], fromSec: toSec - input.stepSec, toSec };
    if (labels.reasons[bucket]) {
      segment.reason = labels.reasons[bucket];
    }
    if (labels.idleRuns[bucket]) {
      segment.idleRun = labels.idleRuns[bucket];
    }
    segments.push(segment);
  }
  return segments;
}

/**
 * The median of a series over the buckets of a phase. The median, not the
 * mean: the buckets in which a phase begins or ends hold a part of the
 * neighbouring phase, and a few of them would pull a mean far off (a compute
 * bucket that ends in a checkpoint carries a share of its write burst).
 */
function typicalWhere(series: Float64Array, labels: PhaseId[], phase: PhaseId): number | null {
  const values: number[] = [];
  for (let bucket = 0; bucket < series.length; bucket++) {
    if (labels[bucket] === phase) {
      values.push(series[bucket]);
    }
  }
  return quantile(values, 0.5);
}

function buildEvidence(series: JobSeries, labels: PhaseId[], phase: PhaseId): PhaseEvidence {
  return {
    gpuPowerWatts: typicalWhere(series.gpuPower, labels, phase),
    gpuUtilPercent: typicalWhere(series.gpuUtil, labels, phase),
    cpuBusy: typicalWhere(series.cpuBusy, labels, phase),
    storageWriteBytesPerSecond: typicalWhere(series.storageWrite, labels, phase),
    networkBytesPerSecond: typicalWhere(series.network, labels, phase),
  };
}

function buildTotals(segments: PhaseSegment[], labels: PhaseId[], series: JobSeries, input: PhaseInput): PhaseTotal[] {
  const windowSeconds = input.bucketCount * input.stepSec;
  const totals: PhaseTotal[] = [];
  for (const phase of PHASE_ORDER) {
    const own = segments.filter((segment) => segment.phase === phase);
    if (own.length === 0) {
      continue;
    }
    const seconds = own.reduce((sum, segment) => sum + (segment.toSec - segment.fromSec), 0);
    totals.push({
      phase,
      seconds,
      share: seconds / windowSeconds,
      segmentCount: own.length,
      evidence: buildEvidence(series, labels, phase),
    });
  }
  return totals;
}

function buildReasonTotals(segments: PhaseSegment[]): ReasonTotal[] {
  const totals: ReasonTotal[] = [];
  for (const reason of UNCLASSIFIED_REASONS) {
    const own = segments.filter((segment) => segment.reason === reason);
    if (own.length > 0) {
      totals.push({
        reason,
        seconds: own.reduce((sum, segment) => sum + (segment.toSec - segment.fromSec), 0),
        segmentCount: own.length,
      });
    }
  }
  return totals;
}

/**
 * Runs in which a node's GPUs were idle while at least one other node of the
 * job worked. In a job of two nodes there is no majority when one node
 * stops, so the test is not "while the job computed".
 */
function findIdleNodes(nodeStates: Uint8Array[], working: Uint16Array, input: PhaseInput, thresholds: PhaseThresholds): NodeIdleFinding[] {
  const findings: NodeIdleFinding[] = [];
  nodeStates.forEach((row, nodeIndex) => {
    let runStart = -1;
    for (let bucket = 0; bucket <= input.bucketCount; bucket++) {
      const idle = bucket < input.bucketCount && row[bucket] === NODE_IDLE && working[bucket] > 0;
      if (idle && runStart < 0) {
        runStart = bucket;
      } else if (!idle && runStart >= 0) {
        if ((bucket - runStart) * input.stepSec >= thresholds.stallMinSeconds) {
          findings.push({
            nodeIndex,
            fromSec: input.startSec + runStart * input.stepSec,
            toSec: input.startSec + bucket * input.stepSec,
          });
        }
        runStart = -1;
      }
    }
  });
  return findings.sort((a, b) => b.toSec - b.fromSec - (a.toSec - a.fromSec) || a.fromSec - b.fromSec || a.nodeIndex - b.nodeIndex);
}

function coverageOf(matrix: SignalMatrix | undefined, input: PhaseInput): number {
  const cells = input.nodeCount * input.bucketCount;
  if (!matrix || cells === 0) {
    return 0;
  }
  let present = 0;
  for (let node = 0; node < input.nodeCount; node++) {
    for (let bucket = 0; bucket < input.bucketCount; bucket++) {
      if (Number.isFinite(cell(matrix, node, bucket))) {
        present += 1;
      }
    }
  }
  return present / cells;
}

function buildCoverage(input: PhaseInput): Record<SignalName, number> {
  const coverage = {} as Record<SignalName, number>;
  for (const name of SIGNAL_NAMES) {
    coverage[name] = coverageOf(input.signals[name], input);
  }
  return coverage;
}

function findSilentNodes(nodeStates: Uint8Array[]): number[] {
  const silent: number[] = [];
  nodeStates.forEach((row, nodeIndex) => {
    if (row.every((state) => state === NODE_NO_DATA)) {
      silent.push(nodeIndex);
    }
  });
  return silent;
}

/**
 * Segments a job's timeline. The buckets of the result tile the window
 * [startSec, startSec + bucketCount * stepSec) without gap or overlap, each
 * with exactly one label, so the shares of the totals add up to 1.
 */
export function segmentPhases(input: PhaseInput, thresholds: PhaseThresholds = DEFAULT_PHASE_THRESHOLDS): PhaseResult {
  const level = resolveWorkingLevel(input, thresholds);
  const nodeStates = classifyNodes(input, level, thresholds);
  const { states: jobStates, working } = classifyJob(nodeStates, input);
  const series = buildJobSeries(input);

  const firstCompute = jobStates.indexOf(JOB_COMPUTE);
  const writeBase = medianWhere(series.storageWrite, jobStates, JOB_COMPUTE);
  const cpuBase = medianWhere(series.cpuBusy, jobStates, JOB_COMPUTE);
  const writeBurst = WRITE_BURST_FACTOR * (writeBase ?? 0);
  const writeBurstNode = thresholds.checkpointMinWriteBytesPerSecond;
  const cpuIdleLimit = cpuBase === null ? CPU_NOISE_FLOOR : Math.max(CPU_NOISE_FLOOR, Math.min(CPU_IDLE_MAX, CPU_IDLE_RATIO * cpuBase));

  const labels: Labels = { labels: [], reasons: [], idleRuns: new Array(input.bucketCount).fill(undefined) };
  const context: LabelContext = {
    input,
    jobStates,
    firstCompute,
    storageWrite: series.storageWrite,
    storageWriteNode: series.storageWriteNode,
    writeBurst,
    writeBurstNode,
    levelUnknown: level.levelUnknown,
    cpuIdleLimit,
    stepSec: input.stepSec,
    thresholds,
  };
  for (let bucket = 0; bucket < input.bucketCount; bucket++) {
    const [label, reason] = labelBucket(bucket, context);
    labels.labels.push(label);
    labels.reasons.push(reason);
  }
  resolveStalls(labels, context);

  const segments = buildSegments(labels, input);
  const findings = findIdleNodes(nodeStates, working, input, thresholds);
  return {
    startSec: input.startSec,
    stepSec: input.stepSec,
    bucketCount: input.bucketCount,
    nodeCount: input.nodeCount,
    labels: labels.labels,
    reasons: labels.reasons,
    segments,
    totals: buildTotals(segments, labels.labels, series, input),
    unclassifiedReasons: buildReasonTotals(segments),
    gpuBasis: level.basis,
    workingLevel: {
      gpuPowerWatts: level.usable ? level.powerRef : null,
      gpuUtilPercent: level.usable ? level.utilRef : null,
    },
    baselines: {
      storageWriteBytesPerSecond: writeBase,
      cpuBusy: cpuBase,
      writeBurstBytesPerSecond: writeBurst,
      writeBurstNodeBytesPerSecond: writeBurstNode,
      cpuIdleLimit,
    },
    coverage: buildCoverage(input),
    nodeFindings: findings.slice(0, MAX_NODE_FINDINGS),
    nodeFindingCount: findings.length,
    silentNodes: findSilentNodes(nodeStates),
  };
}
