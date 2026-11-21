/**
 * Turns scores into the scorecard's sentences. Every finding states what
 * was measured (the evidence) and, only when the evidence supports it, what
 * to change (the advice). A score that could not be computed says why.
 */
import { formatDuration } from '../../JobSearch/jobTime';
import { JobEfficiency, NotComputedReason } from './scorecard';
import {
  BOTTLENECK_TIME_SHARE,
  BottleneckScore,
  CPU_SATURATED_PERCENT,
  GpuAttribution,
  GpuEvidence,
  GpuScore,
  IDLE_TIME_SHARE,
  IO_WAIT_HIGH_PERCENT,
  LOW_GPU_UTILIZATION_PERCENT,
  MemoryScore,
} from './score';
import { ResolvedEfficiencySettings } from './settings';
import { CPU_WINDOW_SECONDS, MIN_JOB_SECONDS, POINT_BUDGET, ScoredWindow } from './window';

export type ScoredEfficiency = Extract<JobEfficiency, { kind: 'scored' }>;

/**
 * - warning: the evidence shows waste or a bottleneck; the finding has advice.
 * - ok: the evidence shows none.
 * - unknown: the evidence does not decide it (no data, shared nodes, a
 *   failed query). Never shown as OK.
 */
export type FindingSeverity = 'warning' | 'ok' | 'unknown';

export interface Finding {
  id: 'idle-gpus' | 'idle-gpu-time' | 'gpu-memory' | 'input-pipeline';
  title: string;
  severity: FindingSeverity;
  /** Status word for the badge. */
  label: string;
  evidence: string;
  advice?: string;
}

export interface Tile {
  id: 'time-in-use' | 'idle-gpu-hours' | 'never-active-gpus' | 'peak-gpu-memory';
  label: string;
  value: string;
  detail: string;
}

const LABELS = {
  warning: 'Warning',
  ok: 'OK',
  inconclusive: 'Inconclusive',
  noData: 'No data',
  notApplicable: 'Not applicable',
  failed: 'Query failed',
};

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Percent without decimals; values under 1% keep one decimal so that a small share does not read as 0. */
export function formatPercent(value: number): string {
  const rounded = value > 0 && value < 1 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded}%`;
}

export function formatShare(share: number): string {
  return formatPercent(share * 100);
}

/** A share next to the limit it is compared with: a share under the limit never reads as the limit. */
export function formatShareAgainst(share: number, limit: number): string {
  const text = formatShare(share);
  return share < limit && text === formatShare(limit) ? `${(Math.floor(share * 1000) / 10).toFixed(1)}%` : text;
}

export function formatGpuHours(seconds: number): string {
  const hours = seconds / 3600;
  return hours > 0 && hours < 10 ? hours.toFixed(2) : hours.toFixed(1);
}

export function formatGiB(mib: number): string {
  return `${(mib / 1024).toFixed(1)} GiB`;
}

/** Durations under a minute need seconds; formatDuration rounds them to "0m". */
export function formatSeconds(seconds: number): string {
  return seconds < 60 ? `${Math.round(seconds)}s` : formatDuration(seconds);
}

function formatCount(value: number): string {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1);
}

/** "gpu-node001: GPU 4, 5; gpu-node002: GPU 0", cut after a few GPUs. */
export function listGpus(gpus: GpuEvidence[], limit = 8): string {
  const byNode = new Map<string, string[]>();
  for (const gpu of gpus.slice(0, limit)) {
    byNode.set(gpu.node, [...(byNode.get(gpu.node) ?? []), gpu.gpu]);
  }
  const listed = [...byNode.entries()].map(([node, ids]) => `${node}: GPU ${ids.join(', ')}`).join('; ');
  return gpus.length > limit ? `${listed}; and ${gpus.length - limit} more` : listed;
}

function baseline(settings: ResolvedEfficiencySettings): string {
  return `${formatPercent(settings.idleGpuUtilizationPercent)} utilization`;
}

const IDLE_GPUS = { id: 'idle-gpus' as const, title: 'Idle GPUs' };

/** "Node a", "Nodes a and b", "Nodes a, b, c and 4 more". */
export function listNodes(nodes: string[], limit = 3): string {
  const shown = nodes.slice(0, limit);
  const rest = nodes.length - shown.length;
  const names = rest > 0 ? `${shown.join(', ')} and ${rest} more` : joinWithAnd(shown);
  return `${nodes.length === 1 ? 'Node' : 'Nodes'} ${names}`;
}

/**
 * Why the GPUs that report cannot be matched to the job ("unknown"
 * attribution). Without this match no GPU can be called the job's, idle
 * or not.
 */
function unattributedGpus(gpu: GpuScore, settings: ResolvedEfficiencySettings): string {
  if (gpu.unknownReason === 'silent-nodes') {
    const verb = gpu.silentNodes.length === 1 ? 'reports' : 'report';
    return `${listNodes(gpu.silentNodes)} of the job ${verb} no GPU telemetry (${settings.gpuUtilizationMetric}) in the scored window. slurmdbd does not record how the job's ${plural(gpu.allocatedGpus, 'GPU')} are spread over its nodes, so the GPUs that do report cannot be matched to the job.`;
  }
  return `The job's nodes report ${plural(gpu.observedGpus, 'GPU')}, fewer than the ${gpu.allocatedGpus} the job allocated. Some of the job's GPUs have no telemetry, so the GPUs that do report cannot be matched to the job.`;
}

/** "Request 4 instead of 8", or the advice for a job that used no GPU at all. */
function gpuRequestAdvice(gpu: GpuScore): string {
  const needed = gpu.allocatedGpus - gpu.neverActiveGpus;
  return needed > 0 ? `The workload ran on at most ${plural(needed, 'GPU')}. Request ${needed} instead of ${gpu.allocatedGpus}.` : noGpuUsedAdvice();
}

/** Nodes that report more GPUs than the job allocated: only a lower bound can be shown. */
function sharedIdleGpusFinding(gpu: GpuScore, settings: ResolvedEfficiencySettings): Finding {
  const context = `The job's nodes report ${plural(gpu.observedGpus, 'GPU')}, but the job allocated ${gpu.allocatedGpus}, so the telemetry cannot tell which GPUs belong to the job.`;
  const gaps = gpu.partialGpus > 0 ? ` and ${gpu.partialGpus} more ${gpu.partialGpus === 1 ? 'has' : 'have'} gaps in the telemetry` : '';
  if (gpu.neverActiveGpus === 0) {
    return {
      ...IDLE_GPUS,
      severity: 'unknown',
      label: LABELS.inconclusive,
      evidence: `${context} ${plural(gpu.activeGpus, 'GPU')} on these nodes exceeded ${baseline(settings)}${gaps}, which is enough to cover the allocation, so idle GPUs can be neither shown nor ruled out.`,
    };
  }
  return {
    ...IDLE_GPUS,
    severity: 'warning',
    label: LABELS.warning,
    evidence: `${context} Only ${gpu.activeGpus} of the ${gpu.observedGpus} GPUs ever exceeded ${baseline(settings)}${gaps}, so at least ${gpu.neverActiveGpus} of the ${plural(gpu.allocatedGpus, 'allocated GPU')} never became active.`,
    advice: gpuRequestAdvice(gpu),
  };
}

/** The GPUs that stayed under the baseline but cannot be called idle, as a sentence; empty when there are none. */
function gpusWithGaps(gpu: GpuScore): string {
  if (gpu.partialGpus === 0) {
    return '';
  }
  const one = gpu.partialGpus === 1;
  return ` ${plural(gpu.partialGpus, 'GPU')} did not exceed it in the buckets ${one ? 'it' : 'they'} reported in, but ${one ? 'has' : 'have'} no telemetry for some buckets and ${one ? 'is' : 'are'} not counted as idle.`;
}

function idleGpusFinding(gpu: GpuScore, settings: ResolvedEfficiencySettings): Finding {
  if (gpu.attribution === 'unknown') {
    return {
      ...IDLE_GPUS,
      severity: 'unknown',
      label: LABELS.inconclusive,
      evidence: `${unattributedGpus(gpu, settings)} Idle GPUs can be neither shown nor ruled out.`,
    };
  }
  if (gpu.attribution === 'shared') {
    return sharedIdleGpusFinding(gpu, settings);
  }
  const allocated = plural(gpu.allocatedGpus, 'allocated GPU');
  const peak = gpu.peakConcurrentActiveGpus;
  // Only with telemetry for every GPU in every bucket: a GPU may have been active where it did not report.
  const concurrent = peak ? ` At most ${peak} of them ${peak === 1 ? 'was' : 'were'} active at the same time.` : '';

  if (gpu.neverActiveGpus > 0) {
    const idle = gpu.gpus.filter((item) => item.activity === 'idle');
    return {
      ...IDLE_GPUS,
      severity: 'warning',
      label: LABELS.warning,
      evidence: `${gpu.neverActiveGpus} of the ${allocated} never exceeded ${baseline(settings)} in the scored window (${listGpus(idle)}).${concurrent}${gpusWithGaps(gpu)}`,
      advice: gpuRequestAdvice(gpu),
    };
  }
  if (gpu.activeGpus === gpu.allocatedGpus) {
    return {
      ...IDLE_GPUS,
      severity: 'ok',
      label: LABELS.ok,
      evidence: `All ${allocated} exceeded ${baseline(settings)} at some point.${concurrent}`,
    };
  }
  return {
    ...IDLE_GPUS,
    severity: 'unknown',
    label: LABELS.inconclusive,
    evidence: `No GPU is known to have stayed idle: ${gpu.activeGpus} of the ${allocated} exceeded ${baseline(settings)}.${gpusWithGaps(gpu)}`,
  };
}

function noGpuUsedAdvice(): string {
  return 'No allocated GPU was used. Run the job without GPUs, or check that the program selects the GPU (device placement, CUDA_VISIBLE_DEVICES).';
}

const IDLE_TIME = { id: 'idle-gpu-time' as const, title: 'Idle GPU time' };

/**
 * Idle GPU time is a Warning only when the idle share of the whole
 * allocation is proven, and OK only when it is ruled out. Time without
 * telemetry and shared nodes leave a range, which is Inconclusive.
 */
function idleTimeFinding(gpu: GpuScore, window: ScoredWindow, settings: ResolvedEfficiencySettings): Finding {
  const { time } = gpu;
  const allocated = formatGpuHours(time.allocatedSeconds);
  if (gpu.attribution === 'unknown') {
    return {
      ...IDLE_TIME,
      severity: 'unknown',
      label: LABELS.inconclusive,
      evidence: `${unattributedGpus(gpu, settings)} None of the ${allocated} allocated GPU-hours can be called idle or active.`,
    };
  }
  const idleShare = time.allocatedSeconds > 0 ? time.idleSeconds / time.allocatedSeconds : 0;
  const possibleShare = time.allocatedSeconds > 0 ? (time.idleSeconds + time.unobservedSeconds) / time.allocatedSeconds : 0;
  const definition = `A GPU is idle in a ${formatSeconds(window.step)} bucket when none of its samples exceeds ${baseline(settings)}.`;
  const unobserved =
    time.unobservedSeconds > 0
      ? ` ${formatGpuHours(time.unobservedSeconds)} GPU-hours have no telemetry that belongs to the job and count as neither idle nor active.`
      : '';
  const measured = `${time.bounded ? 'At least ' : ''}${formatGpuHours(time.idleSeconds)} of the ${allocated} allocated GPU-hours were idle (${formatShareAgainst(idleShare, IDLE_TIME_SHARE)}).`;
  const evidence = `${measured} ${definition}${unobserved}`;
  const limit = formatShare(IDLE_TIME_SHARE);

  if (idleShare >= IDLE_TIME_SHARE) {
    return {
      ...IDLE_TIME,
      severity: 'warning',
      label: LABELS.warning,
      evidence,
      advice:
        'The allocation held GPUs that did no work for a large part of the job. End the allocation when the work is done, and run phases that need no GPU (data preparation, waiting for input) outside the GPU job.',
    };
  }
  if (time.bounded) {
    return {
      ...IDLE_TIME,
      severity: 'unknown',
      label: LABELS.inconclusive,
      evidence: `${evidence} The nodes are shared with other jobs, so this is a lower bound: the ${limit} that marks idle time is neither reached nor ruled out.`,
    };
  }
  if (possibleShare >= IDLE_TIME_SHARE) {
    return {
      ...IDLE_TIME,
      severity: 'unknown',
      label: LABELS.inconclusive,
      evidence: `${evidence} If they were idle, ${formatShare(possibleShare)} of the allocation was: the ${limit} that marks idle time is neither reached nor ruled out.`,
    };
  }
  return { ...IDLE_TIME, severity: 'ok', label: LABELS.ok, evidence };
}

function memoryFinding(memory: MemoryScore, gpu: GpuScore, settings: ResolvedEfficiencySettings): Finding {
  const base = { id: 'gpu-memory' as const, title: 'GPU memory headroom' };
  const threshold = formatPercent(settings.lowGpuMemoryPercent);
  const name = memory.fullest ? `${memory.fullest.node} GPU ${memory.fullest.gpu}` : '';
  const peak = memory.fullest
    ? `${formatGiB(memory.fullest.peakMiB)} of ${formatGiB(memory.fullest.capacityMiB)} (${formatShare(memory.fullest.share)})`
    : '';

  switch (memory.status) {
    case 'low':
      return {
        ...base,
        severity: 'warning',
        label: LABELS.warning,
        evidence: `The fullest GPU (${name}) peaked at ${peak}. Every GPU stayed below ${threshold} of its memory.`,
        advice:
          'A GPU type with less memory would hold this workload. If the job needs these GPUs for speed, a larger batch size would use the free memory.',
      };
    case 'ok':
      return {
        ...base,
        severity: 'ok',
        label: LABELS.ok,
        evidence: `The fullest GPU (${name}) peaked at ${peak}. Memory use counts as low under ${threshold}.`,
      };
    case 'inconclusive':
      if (memory.reason === 'unattributed-gpus') {
        return { ...base, severity: 'unknown', label: LABELS.inconclusive, evidence: `${unattributedGpus(gpu, settings)} GPU memory is not judged.` };
      }
      return {
        ...base,
        severity: 'unknown',
        label: LABELS.inconclusive,
        evidence:
          memory.reason === 'shared-gpus'
            ? `The fullest GPU on the job's nodes (${name}) peaked at ${peak}, but the nodes are shared, so it may belong to another job.`
            : `The fullest GPU with memory telemetry (${name}) peaked at ${peak}, under the ${threshold} below which memory use counts as low. But the memory telemetry covers every bucket of the scored window for only ${memory.gpusCovered} of the ${plural(gpu.observedGpus, 'GPU')}, so the memory use may have been higher where it is missing.`,
      };
    case 'capacity-unknown':
      return {
        ...base,
        severity: 'unknown',
        label: LABELS.noData,
        evidence: `Peak memory use was ${formatGiB(memory.highestPeakMiB ?? 0)}, but ${settings.gpuMemoryFreeMetric} has no data for the job's nodes, so the capacity is unknown.`,
      };
    case 'no-data':
      return {
        ...base,
        severity: 'unknown',
        label: LABELS.noData,
        evidence: `${settings.gpuMemoryUsedMetric} has no data for the job's nodes in the scored window.`,
      };
    case 'not-applicable':
      return {
        ...base,
        severity: 'unknown',
        label: LABELS.notApplicable,
        evidence: 'No GPU was active, so memory use says nothing about the workload.',
      };
    case 'failed':
      return { ...base, severity: 'unknown', label: LABELS.failed, evidence: `GPU memory was not scored. ${memory.error ?? ''}`.trim() };
  }
}

function joinWithAnd(parts: string[]): string {
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

const BOTTLENECK = { id: 'input-pipeline' as const, title: 'CPU and I/O bottleneck' };
const UNDERUSED = `the GPUs in use averaged under ${LOW_GPU_UTILIZATION_PERCENT}% utilization`;
const BOTTLENECK_LIMIT = formatShare(BOTTLENECK_TIME_SHARE);

/** The parts that the sentences about a tallied bottleneck score share. */
interface BottleneckText {
  /** The CPUs the busy CPUs are compared with. */
  jobCpus: number;
  /** How many windows were read and how many of them count. */
  basis: string;
  /** "at least " when windows without telemetry make the shares lower bounds. */
  atLeast: string;
  /** The measured means while the GPUs were underused, as a sentence with a leading space; may be empty. */
  means: string;
}

function bottleneckText(bottleneck: BottleneckScore): BottleneckText {
  const jobCpus = bottleneck.cpuAttribution === 'unknown' ? (bottleneck.nodeCpus ?? 0) : bottleneck.allocatedCpus;
  const sampled =
    bottleneck.coverage < 0.95 ? `, which sample ${formatShare(bottleneck.coverage)} of the scored window` : '';
  const unscored = bottleneck.unscoredWindows;
  const incomplete =
    unscored > 0 ? `, and ${unscored} more ${unscored === 1 ? 'has' : 'have'} incomplete CPU or GPU telemetry` : '';
  const basis = `CPU load and GPU utilization were compared in ${plural(bottleneck.windows, 'window')} of ${formatSeconds(CPU_WINDOW_SECONDS)}${sampled}. A GPU was in use in ${bottleneck.scoredWindows} of them${incomplete}.`;

  const means: string[] = [];
  if (bottleneck.meanGpuUtilizationWhileLow !== undefined) {
    means.push(`GPU utilization averaged ${formatPercent(bottleneck.meanGpuUtilizationWhileLow)}`);
  }
  if (bottleneck.meanBusyCpusWhileLow !== undefined) {
    means.push(
      bottleneck.cpuAttribution === 'exclusive'
        ? `${formatCount(bottleneck.meanBusyCpusWhileLow)} of ${jobCpus} CPUs were busy`
        : `${formatCount(bottleneck.meanBusyCpusWhileLow)} of the nodes' ${bottleneck.nodeCpus} CPUs were busy`
    );
  }
  if (bottleneck.meanIoWaitCpusWhileLow !== undefined) {
    means.push(`${formatCount(bottleneck.meanIoWaitCpusWhileLow)} CPUs waited for I/O`);
  }
  return {
    jobCpus,
    basis,
    atLeast: unscored > 0 ? 'at least ' : '',
    means: means.length > 0 ? ` While the GPUs were underused, ${joinWithAnd(means)}.` : '',
  };
}

/** A proven CPU bottleneck, I/O bottleneck or both. */
function boundBottleneck(bottleneck: BottleneckScore): Finding {
  const text = bottleneckText(bottleneck);
  const share = (value: number) => `In ${text.atLeast}${formatShare(value)} of these windows, ${UNDERUSED}`;
  const cpuBound = bottleneck.status !== 'io-bound';
  const ioBound = bottleneck.status !== 'cpu-bound';
  const sentences: string[] = [];
  const advice: string[] = [];
  if (cpuBound) {
    sentences.push(`${share(bottleneck.cpuStarvedShare)} while at least ${CPU_SATURATED_PERCENT}% of the job's ${text.jobCpus} CPUs were busy.`);
    advice.push(
      'The GPUs wait for the CPUs that prepare their input. Request more CPUs per GPU and use them (more data-loader workers), or prepare the data before the job.'
    );
  }
  if (ioBound) {
    sentences.push(`${share(bottleneck.ioStarvedShare)} while at least ${IO_WAIT_HIGH_PERCENT}% of the job's CPU time waited for I/O.`);
    advice.push(
      'The GPUs wait for storage. Copy the dataset to node-local or faster storage before training, or pack many small files into larger ones.'
    );
  }
  return {
    ...BOTTLENECK,
    severity: 'warning',
    label: LABELS.warning,
    evidence: `${text.basis} ${sentences.join(' ')}${text.means}`,
    advice: advice.join(' '),
  };
}

/** Both bottlenecks ruled out. */
function clearBottleneck(bottleneck: BottleneckScore): Finding {
  const text = bottleneckText(bottleneck);
  const atMost = (proven: number, most: number) => `${most > proven ? 'at most ' : ''}${formatShareAgainst(most, BOTTLENECK_TIME_SHARE)}`;
  const evidence =
    bottleneck.lowGpuShare === 0 && bottleneck.unscoredWindows === 0
      ? `${text.basis} In all of these, the GPUs in use averaged ${LOW_GPU_UTILIZATION_PERCENT}% utilization or more.`
      : `${text.basis} In ${formatShare(bottleneck.lowGpuShare)} of the windows with a GPU in use, ${UNDERUSED}. Saturated CPUs coincided with that in ${atMost(bottleneck.cpuStarvedShare, bottleneck.cpuStarvedShareMax)} and high I/O wait in ${atMost(bottleneck.ioStarvedShare, bottleneck.ioStarvedShareMax)} of these windows, both under the ${BOTTLENECK_LIMIT} that marks a bottleneck.${text.means}`;
  return {
    ...BOTTLENECK,
    severity: 'ok',
    label: LABELS.ok,
    evidence:
      bottleneck.cpuAttribution === 'shared'
        ? `${evidence} The job holds ${bottleneck.allocatedCpus} of the ${bottleneck.nodeCpus} CPUs of its nodes; the node-wide CPU load includes other jobs and so bounds the job's own from above.`
        : evidence,
  };
}

function bottleneckFinding(bottleneck: BottleneckScore, gpu: GpuScore, settings: ResolvedEfficiencySettings): Finding {
  switch (bottleneck.status) {
    case 'cpu-bound':
    case 'io-bound':
    case 'cpu-and-io-bound':
      return boundBottleneck(bottleneck);
    case 'ok':
      return clearBottleneck(bottleneck);
    case 'inconclusive':
      return {
        ...BOTTLENECK,
        severity: 'unknown',
        label: LABELS.inconclusive,
        evidence:
          bottleneck.reason === 'unattributed-gpus'
            ? `${unattributedGpus(gpu, settings)} GPU utilization cannot be paired with the CPU load.`
            : inconclusiveBottleneck(bottleneck),
      };
    case 'no-data':
      return {
        ...BOTTLENECK,
        severity: 'unknown',
        label: LABELS.noData,
        evidence: "node_cpu_seconds_total has no data for the job's nodes in the scored window.",
      };
    case 'not-applicable':
      return {
        ...BOTTLENECK,
        severity: 'unknown',
        label: LABELS.notApplicable,
        evidence: 'No GPU was in use in the windows in which the CPU load is read, so there is no GPU load to pair the CPU load with.',
      };
    case 'failed':
      return {
        ...BOTTLENECK,
        severity: 'unknown',
        label: LABELS.failed,
        evidence: `The CPU and I/O bottleneck was not scored. ${bottleneck.error ?? ''}`.trim(),
      };
  }
}

/** Why a tallied score decides nothing: shared CPUs, or windows without telemetry. */
function undecidedBottleneck(bottleneck: BottleneckScore): string {
  const text = bottleneckText(bottleneck);
  const range = (proven: number, most: number) =>
    most > proven ? `${formatShare(proven)} to ${formatShare(most)}` : formatShareAgainst(proven, BOTTLENECK_TIME_SHARE);
  switch (bottleneck.reason) {
    case 'shared-cpus':
      return `The job holds ${bottleneck.allocatedCpus} of the ${bottleneck.nodeCpus} CPUs of its nodes, so busy or waiting CPUs may belong to other jobs. ${text.basis} In ${text.atLeast}${formatShare(bottleneck.cpuStarvedShare)} of these windows, ${UNDERUSED} while the node-wide load reached the job's CPU saturation level, and in ${text.atLeast}${formatShare(bottleneck.ioStarvedShare)} while it reached the job's I/O wait level.${text.means}`;
    case 'no-io-wait-data':
      return `${text.basis} Saturated CPUs coincided with underused GPUs in ${range(bottleneck.cpuStarvedShare, bottleneck.cpuStarvedShareMax)} of these windows, under the ${BOTTLENECK_LIMIT} that marks a bottleneck. I/O wait has no data (node_cpu_seconds_total with mode="iowait"), so an I/O bottleneck is not ruled out.`;
    default:
      return `${text.basis} Saturated CPUs coincided with underused GPUs in ${range(bottleneck.cpuStarvedShare, bottleneck.cpuStarvedShareMax)} of these windows and high I/O wait in ${range(bottleneck.ioStarvedShare, bottleneck.ioStarvedShareMax)}, depending on what happened in the windows without complete telemetry. The ${BOTTLENECK_LIMIT} that marks a bottleneck is neither reached nor ruled out.`;
  }
}

function inconclusiveBottleneck(bottleneck: BottleneckScore): string {
  const window = formatSeconds(CPU_WINDOW_SECONDS);
  switch (bottleneck.reason) {
    case 'shared-gpus':
      return "The job's nodes report more GPUs than the job allocated, so GPU utilization cannot be attributed to the job.";
    case 'no-window':
      return `The scored window is shorter than the ${window} that one reading of the CPU load needs.`;
    case 'silent-cpu-nodes': {
      const nodes = bottleneck.silentNodes;
      return `${listNodes(nodes)} of the job ${nodes.length === 1 ? 'reports' : 'report'} no CPU telemetry (node_cpu_seconds_total) in the scored window, so the CPU load of the job is not known.`;
    }
    case 'cpu-allocation-unknown':
      return "The job's AllocTRES records no CPU count, so the node-wide CPU load cannot be compared with the job's allocation.";
    case 'cpu-allocation-exceeds-nodes':
      return `The job's AllocTRES records ${bottleneck.allocatedCpus} CPUs, but its nodes report ${bottleneck.nodeCpus}, so a part of the job's CPUs has no telemetry.`;
    case 'cpu-telemetry-out-of-range':
      return "node_cpu_seconds_total does not add up to one second per second and CPU on the job's nodes, so it is not node_exporter's per-CPU counter and the CPU load cannot be scored.";
    case 'too-few-windows':
      return `The CPU load is read in one window of ${window} per bucket. This job has ${plural(bottleneck.windows, 'window')}, which sample ${formatShare(bottleneck.coverage)} of the scored window: too little to judge a bottleneck.`;
    default:
      return undecidedBottleneck(bottleneck);
  }
}

export function buildFindings(result: ScoredEfficiency): Finding[] {
  return [
    idleGpusFinding(result.gpu, result.settings),
    idleTimeFinding(result.gpu, result.window, result.settings),
    memoryFinding(result.memory, result.gpu, result.settings),
    bottleneckFinding(result.bottleneck, result.gpu, result.settings),
  ];
}

/** The GPU tiles of a job whose reporting GPUs cannot be matched to it: no number is shown as the job's. */
function unattributedTiles(gpu: GpuScore): Tile[] {
  const allocated = `of ${formatGpuHours(gpu.time.allocatedSeconds)} allocated`;
  const why =
    gpu.unknownReason === 'silent-nodes'
      ? `${plural(gpu.silentNodes.length, 'node')} without GPU telemetry`
      : `${plural(gpu.observedGpus, 'GPU')} reporting, ${gpu.allocatedGpus} allocated`;
  return [
    { id: 'time-in-use', label: 'GPU time in use', value: 'Unknown', detail: 'telemetry cannot be matched to the job' },
    { id: 'idle-gpu-hours', label: 'Idle GPU-hours', value: 'Unknown', detail: allocated },
    { id: 'never-active-gpus', label: 'Never-active GPUs', value: 'Unknown', detail: why },
  ];
}

function gpuTiles(gpu: GpuScore): Tile[] {
  if (gpu.attribution === 'unknown') {
    return unattributedTiles(gpu);
  }
  const { time } = gpu;
  const observedSeconds = time.activeSeconds + time.idleSeconds;
  const reporting = `${plural(gpu.observedGpus, 'GPU')} reporting`;
  return [
    {
      id: 'time-in-use',
      label: 'GPU time in use',
      value: gpu.timeInUseShare === undefined ? 'No data' : `${time.bounded ? '≤ ' : ''}${formatShare(gpu.timeInUseShare)}`,
      detail: `${formatGpuHours(time.activeSeconds)} of ${formatGpuHours(observedSeconds)} observed GPU-hours`,
    },
    {
      id: 'idle-gpu-hours',
      label: 'Idle GPU-hours',
      value: `${time.bounded ? '≥ ' : ''}${formatGpuHours(time.idleSeconds)}`,
      detail:
        time.unobservedSeconds > 0
          ? `of ${formatGpuHours(time.allocatedSeconds)} allocated; ${formatGpuHours(time.unobservedSeconds)} without telemetry`
          : `of ${formatGpuHours(time.allocatedSeconds)} allocated`,
    },
    {
      id: 'never-active-gpus',
      label: 'Never-active GPUs',
      value: `${gpu.attribution === 'shared' ? '≥ ' : ''}${gpu.neverActiveGpus} of ${gpu.allocatedGpus}`,
      detail: gpu.partialGpus > 0 ? `${reporting}, ${gpu.partialGpus} with gaps` : reporting,
    },
  ];
}

function memoryTile(memory: MemoryScore, attribution: GpuAttribution): Tile {
  const tile = { id: 'peak-gpu-memory' as const, label: 'Peak GPU memory' };
  if (attribution === 'unknown') {
    return { ...tile, value: 'Unknown', detail: 'telemetry cannot be matched to the job' };
  }
  if (!memory.fullest) {
    return { ...tile, value: 'No data', detail: 'no capacity telemetry' };
  }
  const amount = `${formatGiB(memory.fullest.peakMiB)} of ${formatGiB(memory.fullest.capacityMiB)}`;
  return {
    ...tile,
    value: formatShare(memory.fullest.share),
    detail:
      attribution === 'exact' ? `${amount} on the fullest GPU` : `${amount} on the fullest GPU of the job's nodes, which may be another job's`,
  };
}

export function buildTiles(result: ScoredEfficiency): Tile[] {
  return [...gpuTiles(result.gpu), memoryTile(result.memory, result.gpu.attribution)];
}

/** Sentences about what the scores cover: the window, a running job, gaps. */
export function buildWindowNotes(result: ScoredEfficiency | Extract<JobEfficiency, { kind: 'no-telemetry' }>): string[] {
  const { window } = result;
  const notes = [
    `Scored window: ${formatSeconds(window.buckets * window.step)} in ${plural(window.buckets, 'bucket')} of ${formatSeconds(window.step)}.`,
  ];
  if (window.running) {
    const upTo = window.runningLagSeconds > 0 ? `${formatSeconds(window.runningLagSeconds)} ago, when the newest samples have arrived,` : 'now';
    notes.push(`The job is still running: the scores cover the time up to ${upTo} and will change.`);
  }
  const skipped: string[] = [];
  if (window.skippedStartSeconds > 0) {
    skipped.push(`the first ${formatSeconds(window.skippedStartSeconds)}`);
  }
  if (window.skippedEndSeconds > 0) {
    skipped.push(`the last ${formatSeconds(window.skippedEndSeconds)}`);
  }
  if (skipped.length > 0) {
    const text = skipped.join(' and ');
    notes.push(`${text.charAt(0).toUpperCase()}${text.slice(1)} of the job fill no whole bucket and are not scored.`);
  }
  if (result.kind === 'scored' && result.gpu.attribution !== 'unknown' && result.gpu.completeBuckets < window.buckets) {
    notes.push(
      `The GPU telemetry is complete in ${result.gpu.completeBuckets} of ${window.buckets} buckets. In the others a GPU or a node did not report, for example because an exporter was down or the job is older than the metrics retention.`
    );
  }
  return notes;
}

/** Explains a state in which nothing was scored. */
const SUSPENDED_RUN =
  'A suspended job keeps its allocation but does not run, and its GPUs may run another job meanwhile. slurmdbd does not record when the job was suspended, so its telemetry cannot be scored against its allocation.';

export function describeNotComputed(result: Extract<JobEfficiency, { kind: 'not-computed' }>): string {
  const messages: Record<NotComputedReason, string> = {
    'no-datasource': 'The cluster has no metrics datasource configured.',
    'invalid-settings': `The cluster's efficiency settings are invalid: ${(result.errors ?? []).join('; ')}.`,
    'not-started': 'The job has not started.',
    'no-gpus-allocated': "The job's AllocTRES records no GPUs, so there is no GPU allocation to compare the telemetry with.",
    suspended:
      result.value === undefined
        ? `The job is suspended, or was suspended for a time that slurmdbd does not record. ${SUSPENDED_RUN}`
        : `The job was suspended for ${formatSeconds(result.value)} of its run. ${SUSPENDED_RUN}`,
    'past-time-limit': `slurmdbd records the job as running, ${formatSeconds(result.value ?? 0)} past its time limit. Its end may be missing from the accounting database (a runaway job) and its nodes may run other jobs by now, so the job is not scored.`,
    'too-short': `The job ran for ${formatSeconds(result.value ?? 0)}. Jobs shorter than ${formatSeconds(MIN_JOB_SECONDS)} hold too few samples to score.`,
    'too-large': `The job's nodes are expected to report about ${result.value ?? 0} GPUs, more than the ${POINT_BUDGET} one scorecard reads.`,
    'missing-gpu-label': `${result.settings.gpuUtilizationMetric} has no "${result.settings.gpuIdLabel}" label on the job's nodes, so the GPUs of a node cannot be told apart. Set the GPU ID label in the cluster's efficiency settings.`,
  };
  return messages[result.reason];
}
