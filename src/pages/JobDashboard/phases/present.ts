/**
 * The words, numbers and colours of the Job phases section. Everything here
 * is pure, so the sentences can be tested without rendering.
 */
import { JobPhasesAnalysis, JobPhasesOutcome, SignalReport } from './collect';
import { MIN_BUCKETS } from './plan';
import { PHASE_ORDER, PhaseId, PhaseSegment, PhaseTotal, SIGNAL_LABELS, SignalName, UnclassifiedReason } from './types';

export const PHASE_LABELS: Record<PhaseId, string> = {
  init: 'Startup',
  compute: 'Compute + collective',
  checkpoint: 'Checkpoint / storage I/O',
  // The label names what was observed: a hang and a job that waits for its user look the same.
  stalled: 'Stalled (GPUs idle)',
  unclassified: 'Unclassified',
  'no-data': 'No GPU data',
};

/** One sentence per phase: what the telemetry showed, not what the job did. */
export const PHASE_DEFINITIONS: Record<PhaseId, string> = {
  init: 'Before the GPUs first reached their working level.',
  compute: 'Most nodes had their GPUs at the working level. Collective communication is part of it: its bursts are far shorter than a bucket.',
  checkpoint: 'GPUs below the working level together with a storage write burst.',
  stalled: 'Every GPU idle for at least the stall time after the job had computed, and the CPUs idle too.',
  unclassified: 'GPU telemetry exists, but the stretch fits none of the four phases.',
  'no-data': 'No node reported GPU telemetry.',
};

export const REASON_TEXT: Record<UnclassifiedReason, string> = {
  'gpu-low': 'GPUs below the working level but not idle, without a storage write burst',
  'gpu-idle-short': 'Every reporting GPU idle for less than the stall time, without a storage write burst',
  'gpu-low-write-unknown':
    'GPUs below the working level, or idle for less than the stall time; the storage write rate is unknown, so a checkpoint cannot be told',
  'gpu-idle-cpu-busy': 'Every GPU idle for the stall time, but the CPUs were not idle: CPU-only work, or a hang that keeps CPUs busy',
  'gpu-idle-cpu-unknown': 'Every GPU idle for the stall time, but the stretch has too little CPU telemetry to tell a stall from CPU-only work',
  'gpu-idle-partial-telemetry': 'Every reporting GPU idle for the stall time, but not every node reported',
  'nodes-disagree': 'No majority: some nodes were at the working level, others were not',
  'partial-telemetry': 'At most half of the nodes reported GPU telemetry',
  'no-compute': "In no bucket did more than half of the nodes reach the job's working level, so there is nothing to compare with",
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

export { SIGNAL_LABELS };

const STATUS_TEXT: Record<SignalReport['status'], string> = {
  ok: 'used',
  'no-series': 'no series',
  'too-few-samples': 'too few samples for a rate',
  invalid: 'values not usable',
};

function basisStatus(report: SignalReport, covered: string): string {
  if (report.status === 'ok') {
    return report.unusableValues ? `${STATUS_TEXT.ok}, ${covered}; ${report.unusableValues} of ${report.values} values left out` : `${STATUS_TEXT.ok}, ${covered}`;
  }
  return report.status === 'invalid' && report.unusableValues
    ? `${STATUS_TEXT.invalid}: ${report.unusableValues} of ${report.values} outside 0 to 100%`
    : STATUS_TEXT[report.status];
}

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
        status: basisStatus(report, covered),
        available: report.status === 'ok',
      };
    });
}

/** Below this share of node buckets with a sample, a signal that is used gets a note. */
const LOW_COVERAGE = 0.9;

/** How a missing signal is named when it has no series at all. */
const WITHOUT: Partial<Record<SignalName, string>> = {
  gpuUtilMax: 'Without GPU utilization',
  gpuPower: 'Without GPU power',
  storageWrite: 'Without a storage write series',
  cpuBusy: 'Without a CPU series',
};

/** What the result loses when a signal cannot be used, whatever the cause. */
const CONSEQUENCE: Partial<Record<SignalName, string>> = {
  gpuUtilMax: 'idle cannot be proven from power alone: no stall is reported.',
  gpuPower: 'the working level is judged on utilization alone: a GPU that spins at full utilization without doing work is not seen.',
  storageWrite: 'no checkpoint is reported: GPU dips stay unclassified.',
  cpuBusy: 'no stall is reported: a stall needs idle CPUs, so idle GPUs stay unclassified.',
};

/** Why the values of a signal are not used although the query returned some. */
function invalidCause(report: SignalReport): string {
  if (report.unusableValues) {
    return `${report.unusableValues} of ${report.values} values are outside 0 to 100%, more than a tenth, so the signal is not used`;
  }
  return 'the backend returned its points beside the bucket grid, so the signal is not used';
}

/**
 * The note for a signal that is not used. The cause is stated as it is: "without a series" only when
 * there is none, and otherwise what was wrong with the series that exists. The consequence follows.
 */
function unavailableNote(report: SignalReport, analysis: JobPhasesAnalysis): string | null {
  // The two utilization queries read one metric; the note is given once.
  if (report.status === 'ok' || report.signal === 'gpuUtilMean') {
    return null;
  }
  const consequence = CONSEQUENCE[report.signal];
  if (report.status === 'no-series') {
    return consequence ? `${WITHOUT[report.signal]}, ${consequence}` : null;
  }
  const cause =
    report.status === 'too-few-samples'
      ? `${report.metrics.join(', ')} has series for the job's nodes, but no bucket of ${formatSeconds(analysis.window.stepSec)} holds the two samples that a rate needs`
      : invalidCause(report);
  const effect = consequence ? `As without the series, ${consequence}` : 'Its column shows no data; it decides no phase.';
  return `${SIGNAL_LABELS[report.signal]}: ${cause}. ${effect}`;
}

/** What a missing signal means for the result. Each sentence names a consequence, not only an absence. */
export function buildLimitNotes(analysis: JobPhasesAnalysis): string[] {
  const notes: string[] = [];
  const order: SignalName[] = ['gpuUtilMax', 'gpuPower', 'storageWrite', 'cpuBusy', 'network'];
  for (const signal of order) {
    const report = analysis.signals.find((item) => item.signal === signal);
    // A signal whose query was not sent has no report; it is as absent as one without a series.
    const note = report ? unavailableNote(report, analysis) : `${WITHOUT[signal]}, ${CONSEQUENCE[signal]}`;
    if (note && (report || CONSEQUENCE[signal])) {
      notes.push(note);
    }
  }
  for (const report of analysis.signals) {
    if (report.status !== 'ok') {
      continue;
    }
    if (report.unusableValues) {
      notes.push(
        `${SIGNAL_LABELS[report.signal]}: ${report.unusableValues} of ${report.values} values ${report.unusableValues === 1 ? 'was' : 'were'} not usable ` +
          '(outside 0 to 100%) and left out; the other values are used. ' +
          'A node exporter that answers late moves CPU time from one bucket into the next.'
      );
    }
    // GPU gaps show on the timeline as "No GPU data"; a thin CPU or write series changes labels without showing.
    if ((report.signal === 'cpuBusy' || report.signal === 'storageWrite') && report.coverage < LOW_COVERAGE) {
      notes.push(
        `${SIGNAL_LABELS[report.signal]} has usable values in only ${Math.floor(100 * report.coverage)}% of the node buckets. ` +
          (report.signal === 'storageWrite'
            ? 'A GPU dip in a bucket without any write sample is unclassified, and the write rate counts only the nodes that report.'
            : 'An idle stretch with CPU values in fewer than half of its buckets is not reported as a stall.')
      );
    }
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
  } else if (analysis.window.running && analysis.jobState !== 'RUNNING') {
    notes.push(
      `Slurm records the job as ${analysis.jobState} without an end time, so the window ends at the present. ` +
        'The job may not be running: idle GPUs at the end of the window are not reported as "stalled now".'
    );
  }
  return notes;
}

export function describeWindow(analysis: JobPhasesAnalysis): { resolution: string; edges: string | null } {
  const { window } = analysis;
  const edgeSeconds = window.startSec - window.runStartSec + (window.runEndSec - window.endSec);
  return {
    resolution:
      `${window.bucketCount} buckets of ${formatSeconds(window.stepSec)} (slowest scrape interval ${window.scrapeSec} s). ` +
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
      return (
        `The job has ${outcome.nodeCount ?? 'too many'} nodes; the phases are computed for jobs of up to ${outcome.maxNodes} nodes. ` +
        'With more nodes, the per-node queries would exceed their size limit or leave too few buckets.'
      );
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

/**
 * For a job that Slurm records as RUNNING: how long the stall at the end of
 * the window has lasted; null when the job is not stalled now. A job without
 * an end time in another state (suspended, pending again after a requeue,
 * completing) is not warned about: its GPUs can be idle because of that
 * state, and the coverage notes say so.
 */
export function stalledNowSeconds(analysis: JobPhasesAnalysis): number | null {
  const last = analysis.result.segments[analysis.result.segments.length - 1];
  if (!analysis.window.running || analysis.jobState !== 'RUNNING' || !last || last.phase !== 'stalled') {
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

/**
 * Neighbouring stretches that are each shorter than this share of the window
 * are drawn as one block on the timeline. At a strip of 700 pixels this is
 * two pixels: narrower neighbours cannot be told apart, and a row of them
 * paints a pattern that is not in the data.
 */
export const TIMELINE_RESOLUTION = 360;

/** One block of the timeline: a stretch, or a run of neighbouring stretches too short to draw one by one. */
export interface TimelineMark {
  fromSec: number;
  toSec: number;
  /** The stretches of the block, in time order. */
  segments: PhaseSegment[];
  /** The share of each label in the block's time, in the order of PHASE_ORDER; the shares add up to 1. */
  shares: Array<{ phase: PhaseId; share: number }>;
}

/**
 * The blocks of the timeline. Every block starts and ends at the true times
 * of its stretches, so the blocks tile the window like the stretches do. A
 * stretch of at least 1/TIMELINE_RESOLUTION of the window is a block of its
 * own, and so is a short stretch between two long ones. Only a run of two
 * or more short stretches becomes one block, which shows the shares of its
 * labels instead of the single stretches.
 */
export function buildTimelineMarks(segments: PhaseSegment[], startSec: number, endSec: number): TimelineMark[] {
  const shortest = (endSec - startSec) / TIMELINE_RESOLUTION;
  const runs: PhaseSegment[][] = [];
  let lastShort = false;
  for (const segment of segments) {
    const short = segment.toSec - segment.fromSec < shortest;
    if (short && lastShort) {
      runs[runs.length - 1].push(segment);
    } else {
      runs.push([segment]);
    }
    lastShort = short;
  }
  return runs.map((run) => {
    const fromSec = run[0].fromSec;
    const toSec = run[run.length - 1].toSec;
    const seconds = new Map<PhaseId, number>();
    for (const segment of run) {
      seconds.set(segment.phase, (seconds.get(segment.phase) ?? 0) + segment.toSec - segment.fromSec);
    }
    const shares = PHASE_ORDER.filter((phase) => seconds.has(phase)).map((phase) => ({ phase, share: seconds.get(phase)! / (toSec - fromSec) }));
    return { fromSec, toSec, segments: run, shares };
  });
}

/** The readout of a block with several stretches: the shares of its labels, in the order of the legend. */
export function describeMixedMark(mark: TimelineMark): string {
  const shares = mark.shares.map(({ phase, share }) => `${(100 * share).toFixed(1)}% ${PHASE_LABELS[phase]}`).join(', ');
  return `${mark.segments.length} stretches, each too short to draw on its own: ${shares}`;
}
