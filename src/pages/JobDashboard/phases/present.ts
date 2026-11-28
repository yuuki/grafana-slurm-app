/**
 * The words, numbers and colours of the Job phases section. Everything here
 * is pure, so the sentences can be tested without rendering.
 */
import { JobPhasesAnalysis, JobPhasesOutcome, SignalReport } from './collect';
import { MIN_BUCKETS } from './plan';
import { PHASE_ORDER, PhaseId, PhaseTotal, SignalName, UnclassifiedReason } from './types';

export const PHASE_LABELS: Record<PhaseId, string> = {
  init: 'Startup',
  compute: 'Compute + collective',
  checkpoint: 'Checkpoint / storage I/O',
  stalled: 'Stalled',
  unclassified: 'Unclassified',
  'no-data': 'No GPU data',
};

/** One sentence per phase: what the telemetry showed, not what the job did. */
export const PHASE_DEFINITIONS: Record<PhaseId, string> = {
  init: 'Before the GPUs first reached their working level.',
  compute: 'Most nodes had their GPUs at the working level. Collective communication is part of it: its bursts are far shorter than a bucket.',
  checkpoint: 'GPUs below the working level together with a storage write burst.',
  stalled: 'Every GPU idle for at least the stall time, after the job had computed.',
  unclassified: 'GPU telemetry exists, but the stretch fits none of the four phases.',
  'no-data': 'No node reported GPU telemetry.',
};

export const REASON_TEXT: Record<UnclassifiedReason, string> = {
  'gpu-low': 'GPUs below the working level without a storage write burst, and not idle on every node for the stall time',
  'gpu-low-write-unknown': 'GPUs below the working level; the storage write rate is unknown, so a checkpoint cannot be told',
  'gpu-idle-cpu-busy': 'Every GPU idle for the stall time, but the CPUs were at least as busy as during compute',
  'gpu-idle-partial-telemetry': 'Every reporting GPU idle for the stall time, but not every node reported',
  'nodes-disagree': 'No majority: some nodes were at the working level, others were not',
  'partial-telemetry': 'At most half of the nodes reported GPU telemetry',
  'no-compute': 'The GPUs never reached a working level in the analysed window, so there is nothing to compare with',
  'gpu-level-unknown': 'GPU power is flat and there is no utilization series, so working cannot be told from idle',
};

export interface PhaseColor {
  /** Fill of the mark. */
  fill: string;
  /** Text printed on the fill. */
  ink: string;
}

/**
 * Compute, checkpoint and stalled can touch each other on the timeline, so
 * they take three hues that stay apart for every pair, also under colour
 * vision deficiency. Startup only ever touches compute and takes a step of
 * the compute hue nearer to the surface. The two labels that are not phases
 * are neutral; "no data" is hatched, so it differs from "unclassified"
 * without relying on a hue. Light and dark values are selected separately.
 */
const COLORS: Record<'light' | 'dark', Record<Exclude<PhaseId, 'no-data'>, PhaseColor>> = {
  light: {
    init: { fill: '#6aabf1', ink: '#0b0b0b' },
    compute: { fill: '#257de0', ink: '#ffffff' },
    checkpoint: { fill: '#00b894', ink: '#ffffff' },
    stalled: { fill: '#f47230', ink: '#ffffff' },
    unclassified: { fill: '#8e8e8e', ink: '#0b0b0b' },
  },
  dark: {
    init: { fill: '#1757ac', ink: '#ffffff' },
    compute: { fill: '#338ced', ink: '#ffffff' },
    checkpoint: { fill: '#00a888', ink: '#ffffff' },
    stalled: { fill: '#e76624', ink: '#ffffff' },
    unclassified: { fill: '#6e6e6e', ink: '#ffffff' },
  },
};

/** The CSS background of a phase: a solid fill, or a neutral 45° hatch for missing data. */
export function phaseBackground(phase: PhaseId, isDark: boolean): string {
  const mode = isDark ? 'dark' : 'light';
  if (phase === 'no-data') {
    const line = COLORS[mode].unclassified.fill;
    return `repeating-linear-gradient(45deg, ${line} 0, ${line} 1px, transparent 1px, transparent 5px)`;
  }
  return COLORS[mode][phase].fill;
}

/** Shares as percentages with one decimal that add up to exactly 100.0 (largest remainder). */
export function formatShares(totals: PhaseTotal[]): Map<PhaseId, string> {
  const exact = totals.map((total) => total.share * 1000);
  const floors = exact.map(Math.floor);
  let missing = Math.round(exact.reduce((sum, value) => sum + value, 0)) - floors.reduce((sum, value) => sum + value, 0);
  const byRemainder = exact.map((value, index) => ({ index, remainder: value - floors[index] })).sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of byRemainder) {
    if (missing <= 0) {
      break;
    }
    floors[index] += 1;
    missing -= 1;
  }
  const shares = new Map<PhaseId, string>();
  totals.forEach((total, index) => {
    // A phase that exists is never printed as 0.0%.
    shares.set(total.phase, floors[index] === 0 ? '<0.1%' : `${(floors[index] / 10).toFixed(1)}%`);
  });
  return shares;
}

export function formatSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [d > 0 ? `${d}d` : '', h > 0 ? `${h}h` : '', m > 0 ? `${m}m` : '', s > 0 && d === 0 && h === 0 ? `${s}s` : ''].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : '0s';
}

const BYTE_UNITS = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s', 'TiB/s'];

export function formatByteRate(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null) {
    return 'no data';
  }
  let value = bytesPerSecond;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

export function formatNumber(value: number | null, unit: string, digits = 0): string {
  return value === null ? 'no data' : `${value.toFixed(digits)}${unit}`;
}

/** The share of CPU time, as a percentage. */
export function formatCpu(value: number | null): string {
  return value === null ? 'no data' : `${(100 * value).toFixed(value < 0.1 ? 1 : 0)}%`;
}

export const SIGNAL_LABELS: Record<SignalName, string> = {
  gpuUtilMax: 'GPU utilization (highest sample)',
  gpuUtilMean: 'GPU utilization (mean)',
  gpuPower: 'GPU power',
  cpuBusy: 'CPU load',
  storageWrite: 'Storage write rate',
  network: 'Network rate',
};

const STATUS_TEXT: Record<SignalReport['status'], string> = {
  ok: 'used',
  'no-series': 'no series',
  failed: 'query failed',
  invalid: 'values not usable',
};

export interface BasisLine {
  signal: SignalName;
  label: string;
  metrics: string;
  /** For example "used, 98% of node buckets" or "no series". */
  status: string;
  available: boolean;
}

/** What the result is based on: one line per signal, with the metric names and how much of the window they cover. */
export function buildBasis(analysis: JobPhasesAnalysis): BasisLine[] {
  // The two utilization queries read one metric; show it once.
  return analysis.signals
    .filter((report) => report.signal !== 'gpuUtilMean')
    .map((report) => {
      const covered = `${Math.floor(100 * report.coverage)}% of node buckets`;
      return {
        signal: report.signal,
        label: report.signal === 'gpuUtilMax' ? 'GPU utilization' : SIGNAL_LABELS[report.signal],
        metrics: report.metrics.join(', '),
        status: report.status === 'ok' ? `${STATUS_TEXT.ok}, ${covered}` : STATUS_TEXT[report.status],
        available: report.status === 'ok',
      };
    });
}

function available(analysis: JobPhasesAnalysis, signal: SignalName): boolean {
  return analysis.signals.some((report) => report.signal === signal && report.status === 'ok');
}

/** What a missing signal means for the result. Each sentence names a consequence, not only an absence. */
export function buildLimitNotes(analysis: JobPhasesAnalysis): string[] {
  const notes: string[] = [];
  if (!available(analysis, 'gpuUtilMax')) {
    notes.push('Without GPU utilization, idle cannot be proven from power alone: no stall is reported.');
  }
  if (!available(analysis, 'gpuPower')) {
    notes.push('Without GPU power, the working level is judged on utilization alone: a GPU that spins at full utilization without doing work is not seen.');
  }
  if (!available(analysis, 'storageWrite')) {
    notes.push('Without a storage write series, no checkpoint is reported: GPU dips stay unclassified.');
  }
  if (!available(analysis, 'cpuBusy')) {
    notes.push('Without a CPU series, a stall cannot be told from a stretch of CPU-only work.');
  }
  if (!analysis.window.scrapeMeasured) {
    notes.push(`The scrape interval could not be measured; ${analysis.window.scrapeSec} s is assumed.`);
  }
  if (analysis.droppedPoints > 0) {
    notes.push(`${analysis.droppedPoints} points of the responses were not on the bucket grid and were dropped.`);
  }
  return notes;
}

function nodeList(nodes: string[], limit = 5): string {
  const shown = nodes.slice(0, limit).join(', ');
  return nodes.length > limit ? `${shown} and ${nodes.length - limit} more` : shown;
}

/** Facts about the job's nodes and GPUs that limit what the phases cover. */
export function buildCoverageNotes(analysis: JobPhasesAnalysis): string[] {
  const notes: string[] = [];
  const silent = analysis.result.silentNodes.map((index) => analysis.nodes[index]);
  if (silent.length > 0) {
    notes.push(
      `${silent.length} of ${analysis.nodes.length} nodes reported no GPU telemetry in the window (${nodeList(silent)}). ` +
        'A job phase needs more than half of the nodes, and a stall needs all of them.'
    );
  }
  if (analysis.gpuCounts !== null && analysis.gpusAllocated > analysis.gpuCounts.total) {
    notes.push(
      `The nodes report ${analysis.gpuCounts.total} GPUs and the job allocated ${analysis.gpusAllocated}. ` +
        'The idle test covers the GPUs that report.'
    );
  }
  if (analysis.gpusAllocated === 0) {
    notes.push("Slurm records no GPU count for this job, so the plugin cannot check that the nodes' GPUs are all the job's.");
  }
  if (analysis.jobState === 'SUSPENDED') {
    notes.push('Slurm records the job as suspended. A suspended job holds its GPUs without using them, so idle GPUs at the end of the window are the suspension, not a hang.');
  }
  return notes;
}

export function describeWindow(analysis: JobPhasesAnalysis): { resolution: string; edges: string | null } {
  const { window } = analysis;
  const edgeSeconds = window.startSec - window.runStartSec + (window.runEndSec - window.endSec);
  return {
    resolution:
      `${window.bucketCount} buckets of ${formatSeconds(window.stepSec)} (scrape interval ${window.scrapeSec} s). ` +
      `A stretch shorter than about one bucket is not visible, and a boundary is right to within one bucket.`,
    edges: edgeSeconds > 0 ? `${formatSeconds(edgeSeconds)} at the edges of the run is outside the buckets and not analysed.` : null,
  };
}

/** Why a job has no result. Every sentence says what is missing, never that the job is fine. */
export function describeNotComputed(outcome: Extract<JobPhasesOutcome, { state: 'not-computed' }>): string {
  switch (outcome.reason) {
    case 'not-started':
      return 'The job has not started, or has no node.';
    case 'too-short':
      return `The job is too short: the phases need at least ${MIN_BUCKETS} buckets of ${formatSeconds(outcome.stepSec ?? 60)} inside the run.`;
    case 'too-many-nodes':
      return `The job has more nodes than one analysis reads (${outcome.maxNodes}).`;
    case 'no-gpus':
      return 'The job allocated no GPU and its nodes report no GPU utilization. The phases are defined by GPU activity.';
    case 'no-gpu-telemetry':
      return "The job's nodes report no GPU telemetry in the job's run.";
    case 'shared-nodes':
      return (
        `The job's nodes report ${outcome.gpusReported} GPUs and the job allocated ${outcome.gpusAllocated}. ` +
        'GPU telemetry is read per node, so the phases would mix this job with whatever runs on the other GPUs.'
      );
  }
}

export function orderedTotals(analysis: JobPhasesAnalysis): PhaseTotal[] {
  return PHASE_ORDER.map((phase) => analysis.result.totals.find((total) => total.phase === phase)).filter(
    (total): total is PhaseTotal => total !== undefined
  );
}

/** For a running job: how long the stall at the end of the window has lasted; null when the job is not stalled now. */
export function stalledNowSeconds(analysis: JobPhasesAnalysis): number | null {
  const last = analysis.result.segments[analysis.result.segments.length - 1];
  // A suspended job is not warned about: Slurm stopped it, and the coverage notes say so.
  if (!analysis.window.running || analysis.jobState === 'SUSPENDED' || !last || last.phase !== 'stalled') {
    return null;
  }
  return last.toSec - last.fromSec;
}

/**
 * The category and note of a draft label for a stretch. Nothing is written
 * until the user saves the label.
 *
 * The category has no colon: Grafana stores a tag as a key and a value
 * split at colons and drops what follows a second colon, so
 * "slurm-app:category=phase:stalled" would be stored as
 * "slurm-app:category=phase", not as the dialog previews it.
 */
export function draftLabel(phase: PhaseId, reason: UnclassifiedReason | undefined): { category: string; note: string } {
  return {
    category: `phase-${phase}`,
    note: `Detected by the job phase segmentation: ${PHASE_LABELS[phase]}${reason ? ` (${REASON_TEXT[reason]})` : ''}. Review the window before saving.`,
  };
}
