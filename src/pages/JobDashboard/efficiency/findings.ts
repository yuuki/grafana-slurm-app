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
  GpuEvidence,
  GpuScore,
  IDLE_TIME_SHARE,
  IO_WAIT_HIGH_PERCENT,
  LOW_GPU_UTILIZATION_PERCENT,
  MemoryScore,
} from './score';
import { ResolvedEfficiencySettings } from './settings';
import { MIN_JOB_SECONDS, POINT_BUDGET, ScoredWindow } from './window';

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

/** "Request 4 instead of 8", or the advice for a job that used no GPU at all. */
function gpuRequestAdvice(gpu: GpuScore): string {
  const needed = gpu.allocatedGpus - gpu.neverActiveGpus;
  return needed > 0 ? `The workload ran on at most ${plural(needed, 'GPU')}. Request ${needed} instead of ${gpu.allocatedGpus}.` : noGpuUsedAdvice();
}

/** Nodes that report more GPUs than the job allocated: only a lower bound can be shown. */
function sharedIdleGpusFinding(gpu: GpuScore, settings: ResolvedEfficiencySettings): Finding {
  const context = `The job's nodes report ${plural(gpu.observedGpus, 'GPU')}, but the job allocated ${gpu.allocatedGpus}, so the telemetry cannot tell which GPUs belong to the job.`;
  if (gpu.neverActiveGpus === 0) {
    return {
      ...IDLE_GPUS,
      severity: 'unknown',
      label: LABELS.inconclusive,
      evidence: `${context} ${plural(gpu.activeGpus, 'GPU')} on these nodes exceeded ${baseline(settings)}, which is enough to cover the allocation, so idle GPUs can be neither shown nor ruled out.`,
    };
  }
  return {
    ...IDLE_GPUS,
    severity: 'warning',
    label: LABELS.warning,
    evidence: `${context} Only ${gpu.activeGpus} of the ${gpu.observedGpus} GPUs ever exceeded ${baseline(settings)}, so at least ${gpu.neverActiveGpus} of the ${plural(gpu.allocatedGpus, 'allocated GPU')} never became active.`,
    advice: gpuRequestAdvice(gpu),
  };
}

/** The GPUs that could not be judged, as a sentence; empty when every GPU was. */
function unjudgedGpus(gpu: GpuScore): string {
  const unjudged: string[] = [];
  if (gpu.missingGpus > 0) {
    unjudged.push(`${plural(gpu.missingGpus, 'allocated GPU')} ${gpu.missingGpus === 1 ? 'has' : 'have'} no telemetry`);
  }
  if (gpu.partialGpus > 0) {
    unjudged.push(`${plural(gpu.partialGpus, 'GPU')} reported too rarely to be judged`);
  }
  return unjudged.length > 0 ? ` ${unjudged.join(' and ')}.` : '';
}

function idleGpusFinding(gpu: GpuScore, settings: ResolvedEfficiencySettings): Finding {
  if (gpu.attribution === 'shared') {
    return sharedIdleGpusFinding(gpu, settings);
  }
  const allocated = plural(gpu.allocatedGpus, 'allocated GPU');
  const peak = gpu.peakConcurrentActiveGpus;
  const concurrent = peak > 0 ? ` At most ${peak} of them ${peak === 1 ? 'was' : 'were'} active at the same time.` : '';

  if (gpu.neverActiveGpus > 0) {
    const idle = gpu.gpus.filter((item) => item.activity === 'idle');
    return {
      ...IDLE_GPUS,
      severity: 'warning',
      label: LABELS.warning,
      evidence: `${gpu.neverActiveGpus} of the ${allocated} never exceeded ${baseline(settings)} in the scored window (${listGpus(idle)}).${concurrent}${unjudgedGpus(gpu)}`,
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
    evidence: `No GPU with telemetry stayed idle: ${gpu.activeGpus} of the ${allocated} exceeded ${baseline(settings)}.${unjudgedGpus(gpu)}`,
  };
}

function noGpuUsedAdvice(): string {
  return 'No allocated GPU was used. Run the job without GPUs, or check that the program selects the GPU (device placement, CUDA_VISIBLE_DEVICES).';
}

function idleTimeFinding(gpu: GpuScore, window: ScoredWindow, settings: ResolvedEfficiencySettings): Finding {
  const title = 'Idle GPU time';
  const { time } = gpu;
  const observedSeconds = time.activeSeconds + time.idleSeconds;
  const idleShare = observedSeconds > 0 ? time.idleSeconds / observedSeconds : 0;
  const definition = `A GPU is idle in a ${formatSeconds(window.step)} bucket when none of its samples exceeds ${baseline(settings)}.`;
  const unobserved =
    time.unobservedSeconds > 0
      ? ` ${formatGpuHours(time.unobservedSeconds)} allocated GPU-hours have no telemetry and count as neither idle nor active.`
      : '';
  const measured = `${time.bounded ? 'At least ' : ''}${formatGpuHours(time.idleSeconds)} of ${formatGpuHours(observedSeconds)} observed GPU-hours were idle (${formatShare(idleShare)}).`;
  const evidence = `${measured} ${definition}${unobserved}`;

  if (idleShare >= IDLE_TIME_SHARE) {
    return {
      id: 'idle-gpu-time',
      title,
      severity: 'warning',
      label: LABELS.warning,
      evidence,
      advice:
        'The allocation held GPUs that did no work for a large part of the job. End the allocation when the work is done, and run phases that need no GPU (data preparation, waiting for input) outside the GPU job.',
    };
  }
  if (time.bounded) {
    return {
      id: 'idle-gpu-time',
      title,
      severity: 'unknown',
      label: LABELS.inconclusive,
      evidence: `${evidence} The nodes are shared with other jobs, so this is a lower bound.`,
    };
  }
  return { id: 'idle-gpu-time', title, severity: 'ok', label: LABELS.ok, evidence };
}

function memoryFinding(memory: MemoryScore, settings: ResolvedEfficiencySettings): Finding {
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
      return {
        ...base,
        severity: 'unknown',
        label: LABELS.inconclusive,
        evidence:
          memory.reason === 'shared-gpus'
            ? `The fullest GPU on the job's nodes (${name}) peaked at ${peak}, but the nodes are shared, so it may belong to another job.`
            : `The fullest GPU with memory telemetry (${name}) peaked at ${peak}, under the ${threshold} below which memory use counts as low. But only ${plural(memory.gpusWithCapacity, 'GPU')} of the job ${memory.gpusWithCapacity === 1 ? 'has' : 'have'} memory telemetry, so another one may be fuller.`,
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

function bottleneckFinding(bottleneck: BottleneckScore): Finding {
  const base = { id: 'input-pipeline' as const, title: 'CPU and I/O bottleneck' };
  const jobCpus = bottleneck.nodeCpus === undefined ? bottleneck.allocatedCpus : Math.min(bottleneck.allocatedCpus, bottleneck.nodeCpus);
  const underused = `the active GPUs averaged under ${LOW_GPU_UTILIZATION_PERCENT}% utilization`;
  const saturated = `at least ${CPU_SATURATED_PERCENT}% of the job's ${jobCpus} CPUs were busy`;
  const waiting = `at least ${IO_WAIT_HIGH_PERCENT}% of the job's CPU time waited for I/O`;
  const cpuSentence = `In ${formatShare(bottleneck.cpuStarvedShare)} of the time with an active GPU, ${underused} while ${saturated}.`;
  const ioSentence = `In ${formatShare(bottleneck.ioStarvedShare)} of the time with an active GPU, ${underused} while ${waiting}.`;

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
  const meansText = means.length > 0 ? ` While the GPUs were underused, ${joinWithAnd(means)}.` : '';
  const cpuAdvice =
    'The GPUs wait for the CPUs that prepare their input. Request more CPUs per GPU and use them (more data-loader workers), or prepare the data before the job.';
  const ioAdvice =
    'The GPUs wait for storage. Copy the dataset to node-local or faster storage before training, or pack many small files into larger ones.';

  switch (bottleneck.status) {
    case 'cpu-bound':
      return { ...base, severity: 'warning', label: LABELS.warning, evidence: `${cpuSentence}${meansText}`, advice: cpuAdvice };
    case 'io-bound':
      return { ...base, severity: 'warning', label: LABELS.warning, evidence: `${ioSentence}${meansText}`, advice: ioAdvice };
    case 'cpu-and-io-bound':
      return {
        ...base,
        severity: 'warning',
        label: LABELS.warning,
        evidence: `${cpuSentence} ${ioSentence}${meansText}`,
        advice: `${cpuAdvice} ${ioAdvice}`,
      };
    case 'ok': {
      const evidence =
        bottleneck.lowGpuShare === 0
          ? `The active GPUs averaged ${LOW_GPU_UTILIZATION_PERCENT}% utilization or more in all of the time with an active GPU.`
          : `In ${formatShare(bottleneck.lowGpuShare)} of the time with an active GPU, ${underused}. Saturated CPUs coincided with that in ${formatShare(bottleneck.cpuStarvedShare)} and high I/O wait in ${formatShare(bottleneck.ioStarvedShare)} of the time, both under the ${formatShare(BOTTLENECK_TIME_SHARE)} that marks a bottleneck.${meansText}`;
      return {
        ...base,
        severity: 'ok',
        label: LABELS.ok,
        evidence:
          bottleneck.cpuAttribution === 'shared'
            ? `${evidence} The job holds ${bottleneck.allocatedCpus} of the ${bottleneck.nodeCpus} CPUs of its nodes; the node-wide CPU load includes other jobs and so bounds the job's own from above.`
            : evidence,
      };
    }
    case 'inconclusive':
      return { ...base, severity: 'unknown', label: LABELS.inconclusive, evidence: inconclusiveBottleneck(bottleneck, meansText) };
    case 'no-data':
      return {
        ...base,
        severity: 'unknown',
        label: LABELS.noData,
        evidence: "node_cpu_seconds_total has no data for the job's nodes in the scored window.",
      };
    case 'not-applicable':
      return {
        ...base,
        severity: 'unknown',
        label: LABELS.notApplicable,
        evidence: 'No GPU was active while CPU telemetry was available, so there is no GPU load to pair the CPU load with.',
      };
    case 'failed':
      return {
        ...base,
        severity: 'unknown',
        label: LABELS.failed,
        evidence: `The CPU and I/O bottleneck was not scored. ${bottleneck.error ?? ''}`.trim(),
      };
  }
}

function inconclusiveBottleneck(bottleneck: BottleneckScore, meansText: string): string {
  switch (bottleneck.reason) {
    case 'shared-gpus':
      return "The job's nodes report more GPUs than the job allocated, so GPU utilization cannot be attributed to the job.";
    case 'shared-cpus':
      return `The job holds ${bottleneck.allocatedCpus} of the ${bottleneck.nodeCpus} CPUs of its nodes, so busy or waiting CPUs may belong to other jobs. The active GPUs averaged under ${LOW_GPU_UTILIZATION_PERCENT}% utilization while the node-wide load reached the job's CPU saturation level in ${formatShare(bottleneck.cpuStarvedShare)} and its I/O wait level in ${formatShare(bottleneck.ioStarvedShare)} of the time with an active GPU.${meansText}`;
    case 'cpu-telemetry-out-of-range':
      return "node_cpu_seconds_total does not add up to one second per second and CPU on the job's nodes, so it is not node_exporter's per-CPU counter and the CPU load cannot be scored.";
    case 'no-io-wait-data':
      return `Saturated CPUs coincided with underused GPUs in ${formatShare(bottleneck.cpuStarvedShare)} of the time with an active GPU, under the ${formatShare(BOTTLENECK_TIME_SHARE)} that marks a bottleneck. I/O wait has no data (node_cpu_seconds_total with mode="iowait"), so an I/O bottleneck is not ruled out.`;
    default:
      return "The job's AllocTRES records no CPU count, so the node-wide CPU load cannot be compared with the job's allocation.";
  }
}

export function buildFindings(result: ScoredEfficiency): Finding[] {
  return [
    idleGpusFinding(result.gpu, result.settings),
    idleTimeFinding(result.gpu, result.window, result.settings),
    memoryFinding(result.memory, result.settings),
    bottleneckFinding(result.bottleneck),
  ];
}

export function buildTiles(result: ScoredEfficiency): Tile[] {
  const { gpu, memory } = result;
  const { time } = gpu;
  const observedSeconds = time.activeSeconds + time.idleSeconds;
  const tiles: Tile[] = [
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
      detail: gpu.missingGpus > 0 ? `${plural(gpu.missingGpus, 'GPU')} without telemetry` : `${plural(gpu.observedGpus, 'GPU')} reporting`,
    },
  ];
  if (memory.fullest) {
    tiles.push({
      id: 'peak-gpu-memory',
      label: 'Peak GPU memory',
      value: formatShare(memory.fullest.share),
      detail: `${formatGiB(memory.fullest.peakMiB)} of ${formatGiB(memory.fullest.capacityMiB)} on the fullest GPU`,
    });
  } else {
    tiles.push({ id: 'peak-gpu-memory', label: 'Peak GPU memory', value: 'No data', detail: 'no capacity telemetry' });
  }
  return tiles;
}

/** Sentences about what the scores cover: the window, a running job, gaps. */
export function buildWindowNotes(result: ScoredEfficiency | Extract<JobEfficiency, { kind: 'no-telemetry' }>): string[] {
  const { window } = result;
  const notes = [
    `Scored window: ${formatSeconds(window.buckets * window.step)} in ${plural(window.buckets, 'bucket')} of ${formatSeconds(window.step)}.`,
  ];
  if (window.running) {
    notes.push('The job is still running: the scores cover the time up to now and will change.');
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
  if (result.kind === 'scored' && result.gpu.observedBuckets < window.buckets) {
    notes.push(
      `GPU telemetry covers ${result.gpu.observedBuckets} of ${window.buckets} buckets. The rest has no data, for example because the job is older than the metrics retention.`
    );
  }
  return notes;
}

/** Explains a state in which nothing was scored. */
export function describeNotComputed(result: Extract<JobEfficiency, { kind: 'not-computed' }>): string {
  const messages: Record<NotComputedReason, string> = {
    'no-datasource': 'The cluster has no metrics datasource configured.',
    'invalid-settings': `The cluster's efficiency settings are invalid: ${(result.errors ?? []).join('; ')}.`,
    'not-started': 'The job has not started.',
    'no-gpus-allocated': "The job's AllocTRES records no GPUs, so there is no GPU allocation to compare the telemetry with.",
    'too-short': `The job ran for ${formatSeconds(result.value ?? 0)}. Jobs shorter than ${formatSeconds(MIN_JOB_SECONDS)} hold too few samples to score.`,
    'too-large': `The job's nodes are expected to report about ${result.value ?? 0} GPUs, more than the ${POINT_BUDGET} one scorecard reads.`,
    'missing-gpu-label': `${result.settings.gpuUtilizationMetric} has no "${result.settings.gpuIdLabel}" label on the job's nodes, so the GPUs of a node cannot be told apart. Set the GPU ID label in the cluster's efficiency settings.`,
  };
  return messages[result.reason];
}
