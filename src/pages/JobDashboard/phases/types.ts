/**
 * Types of the job phase segmentation (issue #121).
 *
 * docs/job-phases.md is the user guide and defines every phase; the design
 * and its reasons are in
 * docs/superpowers/specs/2026-11-28-job-phase-segmentation-design.md.
 */

/** What one bucket of the timeline is. The last two are not phases. */
export type PhaseId = 'init' | 'compute' | 'checkpoint' | 'stalled' | 'unclassified' | 'no-data';

/** Display and summary order. */
export const PHASE_ORDER: readonly PhaseId[] = ['init', 'compute', 'checkpoint', 'stalled', 'unclassified', 'no-data'];

/** Why a bucket with GPU telemetry fits none of the four phases. */
export type UnclassifiedReason =
  /** GPUs below the job's working level; the storage write rate is known and shows no burst. */
  | 'gpu-low'
  /** GPUs below the job's working level; the storage write rate is unknown, so a checkpoint cannot be told. */
  | 'gpu-low-write-unknown'
  /** Every GPU idle for the stall time, but the CPUs were at least as busy as during compute. */
  | 'gpu-idle-cpu-busy'
  /** Every reporting GPU idle for the stall time, but some nodes of the job report nothing. */
  | 'gpu-idle-partial-telemetry'
  /** No majority of the job's nodes is working, and none is below the working level. */
  | 'nodes-disagree'
  /** At most half of the job's nodes report GPU telemetry. */
  | 'partial-telemetry'
  /** No bucket of the window shows most nodes at a working level, so there is nothing to compare with. */
  | 'no-compute'
  /** Only GPU power is available and it is flat: working cannot be told from idle. */
  | 'gpu-level-unknown';

export const UNCLASSIFIED_REASONS: readonly UnclassifiedReason[] = [
  'gpu-low',
  'gpu-low-write-unknown',
  'gpu-idle-cpu-busy',
  'gpu-idle-partial-telemetry',
  'nodes-disagree',
  'partial-telemetry',
  'no-compute',
  'gpu-level-unknown',
];

/** One row per node of the job, one value per bucket; NaN means no sample. */
export type SignalMatrix = Float64Array[];

export type SignalName = 'gpuPower' | 'gpuUtilMean' | 'gpuUtilMax' | 'cpuBusy' | 'storageWrite' | 'network';

export const SIGNAL_NAMES: readonly SignalName[] = ['gpuPower', 'gpuUtilMean', 'gpuUtilMax', 'cpuBusy', 'storageWrite', 'network'];

/**
 * The per-node, per-bucket telemetry of a job. A signal that is absent (no
 * series, not configured, failed) is left out; it is never filled with zeros.
 *
 * - gpuPower: mean power of the node's GPUs over the bucket, in watts.
 * - gpuUtilMean: mean utilization of the node's GPUs over the bucket, in percent.
 * - gpuUtilMax: highest utilization sample of any GPU of the node in the bucket, in percent.
 * - cpuBusy: share of the node's CPU time that is neither idle nor iowait, 0 to 1.
 * - storageWrite: bytes per second written, summed over the node's devices.
 * - network: bytes per second sent and received, summed over the node's interfaces.
 */
export type PhaseSignals = Partial<Record<SignalName, SignalMatrix>>;

export interface PhaseInput {
  /** Bucket i covers [startSec + i * stepSec, startSec + (i + 1) * stepSec). */
  startSec: number;
  stepSec: number;
  bucketCount: number;
  /** Number of nodes of the job; every matrix has this many rows. */
  nodeCount: number;
  signals: PhaseSignals;
}

export interface PhaseThresholds {
  /** A GPU is idle in a bucket when none of its utilization samples exceeds this. */
  idleGpuUtilizationPercent: number;
  /** All GPUs idle for at least this long, after the job computed, is a stall. */
  stallMinSeconds: number;
  /** A storage write burst needs at least this rate, summed over the job's nodes. */
  checkpointMinWriteBytesPerSecond: number;
}

export interface PhaseSegment {
  phase: PhaseId;
  /** Set for unclassified segments only. */
  reason?: UnclassifiedReason;
  fromSec: number;
  toSec: number;
}

/** Means over the buckets of a phase; null when no bucket has the signal. */
export interface PhaseEvidence {
  gpuPowerWatts: number | null;
  gpuUtilPercent: number | null;
  cpuBusy: number | null;
  storageWriteBytesPerSecond: number | null;
  networkBytesPerSecond: number | null;
}

export interface PhaseTotal {
  phase: PhaseId;
  seconds: number;
  /** seconds / window length; the shares of all totals add up to 1. */
  share: number;
  segmentCount: number;
  evidence: PhaseEvidence;
}

export interface ReasonTotal {
  reason: UnclassifiedReason;
  seconds: number;
  segmentCount: number;
}

/** A node whose GPUs were idle for the stall time while the job as a whole computed. */
export interface NodeIdleFinding {
  nodeIndex: number;
  fromSec: number;
  toSec: number;
}

/** Which GPU signals the working level is based on. */
export type GpuBasis = 'power+utilization' | 'utilization' | 'power' | 'none';

export interface PhaseResult {
  startSec: number;
  stepSec: number;
  bucketCount: number;
  nodeCount: number;
  /** One label per bucket. */
  labels: PhaseId[];
  /** The reason of each unclassified bucket; undefined for the others. */
  reasons: Array<UnclassifiedReason | undefined>;
  /** Maximal runs of equal label and reason; they tile the window without gap or overlap. */
  segments: PhaseSegment[];
  /** One entry per label that occurs, in PHASE_ORDER. */
  totals: PhaseTotal[];
  unclassifiedReasons: ReasonTotal[];
  gpuBasis: GpuBasis;
  /** The job's working level: the 90th percentile of the node buckets with GPU activity. */
  workingLevel: { gpuPowerWatts: number | null; gpuUtilPercent: number | null };
  /** Medians over the compute buckets, and the write rate a burst must reach. */
  baselines: {
    storageWriteBytesPerSecond: number | null;
    cpuBusy: number | null;
    writeBurstBytesPerSecond: number;
  };
  /** Share of the node buckets that hold a sample, per signal; 0 for an absent signal. */
  coverage: Record<SignalName, number>;
  /** Longest first, at most MAX_NODE_FINDINGS. */
  nodeFindings: NodeIdleFinding[];
  nodeFindingCount: number;
  /** Indexes of the nodes without any GPU sample in the window. */
  silentNodes: number[];
}
