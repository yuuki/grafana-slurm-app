import {
  buildFindings,
  buildTiles,
  buildWindowNotes,
  describeNotComputed,
  Finding,
  formatGiB,
  formatGpuHours,
  formatPercent,
  formatSeconds,
  formatShareAgainst,
  listGpus,
  listNodes,
  ScoredEfficiency,
} from './findings';
import { BottleneckScore, GpuBucketSeries, gpuKey, GpuMemoryReading, MemoryScore, scoreBottleneck, scoreGpus, scoreMemory } from './score';
import { EFFICIENCY_DEFAULTS } from './settings';
import { ScoredWindow } from './window';

const BUCKETS = 60;
const STEP = 60;
const WINDOWS = 12;
const COMPARED = 'CPU load and GPU utilization were compared in 12 windows of 5m. A GPU was in use in 12 of them.';

const window: ScoredWindow = {
  status: 'ok',
  running: false,
  runningLagSeconds: 0,
  jobStart: 1_700_000_040,
  jobEnd: 1_700_003_640,
  gridStart: 1_700_000_040,
  gridEnd: 1_700_003_640,
  step: STEP,
  buckets: BUCKETS,
  skippedStartSeconds: 0,
  skippedEndSeconds: 0,
};

function gpu(id: string, utilization: number | undefined, node = 'gpu-node001'): GpuBucketSeries {
  const values = new Array<number | undefined>(BUCKETS).fill(utilization);
  return { instance: `${node}:9400`, node, gpu: id, peak: values, mean: values };
}

/** Every GPU used the same memory of its 80 GiB, with telemetry in every bucket. */
function memoryOf(series: GpuBucketSeries[], usedMiB: number, capacityMiB = 81920): Map<string, GpuMemoryReading> {
  return new Map(
    series.map((item) => [gpuKey(item.instance, item.gpu), { peakUsedMiB: usedMiB, minFreeMiB: capacityMiB - usedMiB, coveredBuckets: BUCKETS }])
  );
}

/** An hour on one 16-CPU node; the job holds all of its CPUs unless told otherwise. */
function scored({
  series,
  allocatedGpus,
  usedMiB = 60000,
  busyShare = 0.5,
  ioWaitShare = 0.01,
  allocatedCpus = 16,
  jobNodes,
  overrides = {},
}: {
  series: GpuBucketSeries[];
  allocatedGpus: number;
  /** The job's nodes; by default the nodes of the series. */
  jobNodes?: string[];
  usedMiB?: number;
  busyShare?: number;
  ioWaitShare?: number;
  allocatedCpus?: number;
  overrides?: Partial<ScoredEfficiency>;
}): ScoredEfficiency {
  const gpuScore = scoreGpus({
    series,
    jobNodes: jobNodes ?? [...new Set(series.map((item) => item.node))],
    allocatedGpus,
    bucketCount: BUCKETS,
    stepSeconds: STEP,
    idleBaselinePercent: EFFICIENCY_DEFAULTS.idleGpuUtilizationPercent,
  });
  const memory = scoreMemory(gpuScore, memoryOf(series, usedMiB), BUCKETS, EFFICIENCY_DEFAULTS.lowGpuMemoryPercent);
  // Twelve windows of five minutes cover the hour. Each GPU's window mean is its bucket mean.
  const fill = <T,>(value: T) => new Array<T>(WINDOWS).fill(value);
  const bottleneck = scoreBottleneck({
    gpuAttribution: gpuScore.attribution,
    allocatedGpus,
    gpuMeans: series.filter((item) => item.mean[0] !== undefined).map((item) => fill(item.mean[0])),
    jobNodes: ['gpu-node001'],
    cpu: [{ node: 'gpu-node001', idle: fill(16 * (1 - busyShare - ioWaitShare)), ioWait: fill(16 * ioWaitShare), count: fill(16), samples: fill(20) }],
    windowCount: WINDOWS,
    windowSeconds: 300,
    // Every window begins well after the job's start.
    windowLeadSeconds: Array.from({ length: WINDOWS }, (_, index) => 600 + index * 300),
    coverage: 1,
    idleBaselinePercent: EFFICIENCY_DEFAULTS.idleGpuUtilizationPercent,
    allocatedCpus,
  });
  return { kind: 'scored', window, settings: EFFICIENCY_DEFAULTS, gpu: gpuScore, memory, bottleneck, ...overrides };
}

function finding(result: ScoredEfficiency, id: Finding['id']): Finding {
  const found = buildFindings(result).find((item) => item.id === id);
  if (!found) {
    throw new Error(`no finding ${id}`);
  }
  return found;
}

const eightGpus = (utilization: (index: number) => number | undefined) =>
  Array.from({ length: 8 }, (_, index) => gpu(String(index), utilization(index)));

describe('formatting', () => {
  it('formats percentages, GPU-hours, memory and durations', () => {
    expect(formatPercent(84.6)).toBe('85%');
    expect(formatPercent(0)).toBe('0%');
    // A small share must not read as zero.
    expect(formatPercent(0.4)).toBe('0.4%');
    expect(formatGpuHours(0)).toBe('0.0');
    expect(formatGpuHours(1800)).toBe('0.50');
    expect(formatGpuHours(3600 * 123.44)).toBe('123.4');
    expect(formatGiB(81920)).toBe('80.0 GiB');
    expect(formatSeconds(45)).toBe('45s');
    expect(formatSeconds(1080)).toBe('18m');
    expect(formatSeconds(3 * 86400)).toBe('3d 0h 0m');
  });

  it('lists GPUs by node and cuts long lists', () => {
    const many = scored({
      series: [...eightGpus(() => 0), ...Array.from({ length: 8 }, (_, index) => gpu(String(index), 0, 'gpu-node002'))],
      allocatedGpus: 16,
    }).gpu.gpus;
    expect(listGpus(many.slice(0, 3))).toBe('gpu-node001: GPU 0, 1, 2');
    expect(listGpus(many, 10)).toBe('gpu-node001: GPU 0, 1, 2, 3, 4, 5, 6, 7; gpu-node002: GPU 0, 1; and 6 more');
  });

  it('lists nodes and cuts long lists', () => {
    expect(listNodes(['n1'])).toBe('Node n1');
    expect(listNodes(['n1', 'n2'])).toBe('Nodes n1 and n2');
    expect(listNodes(['n1', 'n2', 'n3'])).toBe('Nodes n1, n2 and n3');
    expect(listNodes(['n1', 'n2', 'n3', 'n4', 'n5'])).toBe('Nodes n1, n2, n3 and 2 more');
  });

  it('never shows a share under a limit as the limit', () => {
    expect(formatShareAgainst(0.2458, 0.25)).toBe('24.5%');
    expect(formatShareAgainst(0.2499, 0.25)).toBe('24.9%');
    expect(formatShareAgainst(0.25, 0.25)).toBe('25%');
    expect(formatShareAgainst(0.244, 0.25)).toBe('24%');
    expect(formatShareAgainst(0.5, 0.25)).toBe('50%');
  });
});

describe('buildFindings', () => {
  it('reports a job that uses its allocation as OK, with the evidence and without advice', () => {
    const findings = buildFindings(scored({ series: eightGpus(() => 92), allocatedGpus: 8 }));

    expect(findings.map((item) => [item.id, item.severity, item.label])).toEqual([
      ['idle-gpus', 'ok', 'OK'],
      ['idle-gpu-time', 'ok', 'OK'],
      ['gpu-memory', 'ok', 'OK'],
      ['input-pipeline', 'ok', 'OK'],
    ]);
    expect(findings.every((item) => item.advice === undefined)).toBe(true);
    expect(findings[0].evidence).toBe(
      'All 8 allocated GPUs exceeded 5% utilization at some point. At most 8 of them were active at the same time.'
    );
    expect(findings[1].evidence).toBe(
      '0.0 of the 8.00 allocated GPU-hours were idle (0%). A GPU is idle in a 1m bucket when none of its samples exceeds 5% utilization.'
    );
    expect(findings[2].evidence).toBe(
      'The fullest GPU (gpu-node001 GPU 0) peaked at 58.6 GiB of 80.0 GiB (73%). Memory use counts as low under 15%.'
    );
    expect(findings[3].evidence).toBe(`${COMPARED} In all of these, the GPUs in use averaged 50% utilization or more.`);
  });

  it('names the idle GPUs and derives the GPU count to request', () => {
    const result = scored({ series: eightGpus((index) => (index < 4 ? 85 : 0)), allocatedGpus: 8, usedMiB: 9000 });

    expect(finding(result, 'idle-gpus')).toEqual({
      id: 'idle-gpus',
      title: 'Idle GPUs',
      severity: 'warning',
      label: 'Warning',
      evidence:
        '4 of the 8 allocated GPUs never exceeded 5% utilization in the scored window (gpu-node001: GPU 4, 5, 6, 7). At most 4 of them were active at the same time.',
      advice: 'The workload ran on at most 4 GPUs. Request 4 instead of 8.',
    });
    expect(finding(result, 'idle-gpu-time')).toMatchObject({
      severity: 'warning',
      evidence:
        '4.00 of the 8.00 allocated GPU-hours were idle (50%). A GPU is idle in a 1m bucket when none of its samples exceeds 5% utilization.',
      advice: expect.stringContaining('End the allocation when the work is done'),
    });
    expect(finding(result, 'gpu-memory')).toMatchObject({
      severity: 'warning',
      evidence: 'The fullest GPU (gpu-node001 GPU 0) peaked at 8.8 GiB of 80.0 GiB (11%). Every GPU stayed below 15% of its memory.',
      advice: expect.stringContaining('A GPU type with less memory would hold this workload.'),
    });
  });

  it('advises against the GPU allocation when no GPU was used, and does not judge memory or CPUs', () => {
    const result = scored({ series: eightGpus(() => 0), allocatedGpus: 8, usedMiB: 3 });

    expect(finding(result, 'idle-gpus')).toMatchObject({
      severity: 'warning',
      evidence: '8 of the 8 allocated GPUs never exceeded 5% utilization in the scored window (gpu-node001: GPU 0, 1, 2, 3, 4, 5, 6, 7).',
      advice: expect.stringContaining('No allocated GPU was used.'),
    });
    expect(finding(result, 'gpu-memory')).toMatchObject({ severity: 'unknown', label: 'Not applicable' });
    expect(finding(result, 'input-pipeline')).toMatchObject({ severity: 'unknown', label: 'Not applicable' });
  });

  it('judges nothing when the nodes report fewer GPUs than the job allocated', () => {
    const result = scored({ series: eightGpus((index) => (index < 4 ? 88 : undefined)).slice(0, 6), allocatedGpus: 8 });
    const why =
      "The job's nodes report 4 GPUs, fewer than the 8 the job allocated. Some of the job's GPUs have no telemetry, so the GPUs that do report cannot be matched to the job.";

    expect(buildFindings(result).map((item) => [item.id, item.severity, item.label, item.advice])).toEqual([
      ['idle-gpus', 'unknown', 'Inconclusive', undefined],
      ['idle-gpu-time', 'unknown', 'Inconclusive', undefined],
      ['gpu-memory', 'unknown', 'Inconclusive', undefined],
      ['input-pipeline', 'unknown', 'Inconclusive', undefined],
    ]);
    expect(finding(result, 'idle-gpus').evidence).toBe(`${why} Idle GPUs can be neither shown nor ruled out.`);
    expect(finding(result, 'idle-gpu-time').evidence).toBe(`${why} None of the 8.00 allocated GPU-hours can be called idle or active.`);
    expect(finding(result, 'gpu-memory').evidence).toBe(`${why} GPU memory is not judged.`);
    expect(finding(result, 'input-pipeline').evidence).toBe(`${why} GPU utilization cannot be paired with the CPU load.`);
  });

  it('names the nodes without GPU telemetry and accuses the job of nothing, even when the GPU count fits', () => {
    // GPUs 4-7 of gpu-node001 are idle, but the job may hold GPUs 0-3 of
    // each node: gpu-node002 does not report.
    const result = scored({
      series: eightGpus((index) => (index < 4 ? 95 : 0)),
      allocatedGpus: 8,
      usedMiB: 9000,
      jobNodes: ['gpu-node001', 'gpu-node002'],
    });
    const why =
      "Node gpu-node002 of the job reports no GPU telemetry (DCGM_FI_DEV_GPU_UTIL) in the scored window. slurmdbd does not record how the job's 8 GPUs are spread over its nodes, so the GPUs that do report cannot be matched to the job.";

    const findings = buildFindings(result);
    expect(findings.map((item) => item.severity)).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
    expect(findings.every((item) => item.advice === undefined)).toBe(true);
    expect(findings[0].evidence).toBe(`${why} Idle GPUs can be neither shown nor ruled out.`);
    expect(findings[1].evidence).toBe(`${why} None of the 8.00 allocated GPU-hours can be called idle or active.`);
    // No number of the reporting GPUs is shown as the job's.
    expect(buildTiles(result)).toEqual([
      { id: 'time-in-use', label: 'GPU time in use', value: 'Unknown', detail: 'telemetry cannot be matched to the job' },
      { id: 'idle-gpu-hours', label: 'Idle GPU-hours', value: 'Unknown', detail: 'of 8.00 allocated' },
      { id: 'never-active-gpus', label: 'Never-active GPUs', value: 'Unknown', detail: '1 node without GPU telemetry' },
      { id: 'peak-gpu-memory', label: 'Peak GPU memory', value: 'Unknown', detail: 'telemetry cannot be matched to the job' },
    ]);
  });

  it('names several nodes without GPU telemetry', () => {
    const result = scored({ series: eightGpus(() => 0), allocatedGpus: 4, jobNodes: ['gpu-node001', 'gpu-node002', 'gpu-node003'] });
    expect(finding(result, 'idle-gpus')).toMatchObject({
      severity: 'unknown',
      evidence: expect.stringContaining('Nodes gpu-node002 and gpu-node003 of the job report no GPU telemetry'),
    });
  });

  it('calls a GPU with one missing bucket idle, and says what its telemetry covers', () => {
    // GPUs 6 and 7 never exceed the baseline. GPU 7 has no telemetry for one of the 60 buckets.
    const series = eightGpus((index) => (index < 6 ? 90 : 0));
    series[7] = { ...series[7], peak: series[7].peak.map((value, index) => (index === 30 ? undefined : value)) };
    const result = scored({ series, allocatedGpus: 8 });

    expect(finding(result, 'idle-gpus')).toEqual({
      id: 'idle-gpus',
      title: 'Idle GPUs',
      severity: 'warning',
      label: 'Warning',
      evidence:
        '2 of the 8 allocated GPUs never exceeded 5% utilization in any bucket with telemetry (gpu-node001: GPU 6, 7). The GPUs that never exceeded it have telemetry for at least 59 of the 60 buckets of the scored window; the other buckets are not judged.',
      advice: 'In the buckets with telemetry, the workload ran on at most 6 GPUs. Request 6 instead of 8.',
    });
    // The tile counts them, and says what the count rests on.
    expect(buildTiles(result)[2]).toEqual({
      id: 'never-active-gpus',
      label: 'Never-active GPUs',
      value: '2 of 8',
      detail: '8 GPUs reporting; idle GPUs have telemetry for 59 of 60 buckets or more',
    });
  });

  it('says so when no GPU was used in the buckets with telemetry', () => {
    const series = eightGpus(() => 0).map((item) => ({ ...item, peak: item.peak.map((value, index) => (index === 0 ? undefined : value)) }));
    const result = finding(scored({ series, allocatedGpus: 8, usedMiB: 3 }), 'idle-gpus');

    expect(result.evidence).toContain('8 of the 8 allocated GPUs never exceeded 5% utilization in any bucket with telemetry');
    expect(result.advice).toContain('No allocated GPU was used in the buckets with telemetry.');
  });

  it('does not call a GPU idle that has telemetry for less than 95% of the buckets', () => {
    // Three or four of 60 buckets without telemetry: 95% and 93%.
    const gappy = (item: GpuBucketSeries, missing: number): GpuBucketSeries => ({
      ...item,
      peak: item.peak.map((value, index) => (index < missing ? undefined : value)),
    });
    const series = eightGpus((index) => (index < 6 ? 90 : 0));
    const oneGap = scored({ series: [...series.slice(0, 6), gappy(series[6], 3), gappy(series[7], 4)], allocatedGpus: 8 });

    expect(finding(oneGap, 'idle-gpus')).toMatchObject({
      severity: 'warning',
      evidence:
        '1 of the 8 allocated GPUs never exceeded 5% utilization in any bucket with telemetry (gpu-node001: GPU 6). The GPU that never exceeded it has telemetry for at least 57 of the 60 buckets of the scored window; the other buckets are not judged. 1 GPU did not exceed it in the buckets it reported in, but has telemetry for less than 95% of the buckets and is not counted as idle.',
      advice: 'In the buckets with telemetry, the workload ran on at most 7 GPUs. Request 7 instead of 8.',
    });
    // The GPU with too little telemetry may never have been active either: the count is a lower bound.
    expect(buildTiles(oneGap)[2]).toMatchObject({ value: '≥ 1 of 8', detail: '8 GPUs reporting, 1 with gaps; idle GPUs have telemetry for 57 of 60 buckets or more' });

    const onlyGaps = scored({ series: [...series.slice(0, 6), gappy(series[6], 4), gappy(series[7], 30)], allocatedGpus: 8 });
    const idleGpus = finding(onlyGaps, 'idle-gpus');
    expect(idleGpus).toMatchObject({
      severity: 'unknown',
      label: 'Inconclusive',
      evidence:
        'No GPU is known to have stayed idle: 6 of the 8 allocated GPUs exceeded 5% utilization. 2 GPUs did not exceed it in the buckets they reported in, but have telemetry for less than 95% of the buckets and are not counted as idle.',
    });
    expect(idleGpus.advice).toBeUndefined();
    // Not a bare zero: two GPUs were idle in everything that was observed.
    expect(buildTiles(onlyGaps)[2]).toMatchObject({ value: '≥ 0 of 8', detail: '8 GPUs reporting, 2 with gaps' });
  });

  it('says what the memory telemetry covers when it misses a bucket', () => {
    const base = scored({ series: eightGpus(() => 90), allocatedGpus: 8, usedMiB: 9000 });
    expect(finding(base, 'gpu-memory').evidence).toBe(
      'The fullest GPU (gpu-node001 GPU 0) peaked at 8.8 GiB of 80.0 GiB (11%). Every GPU stayed below 15% of its memory.'
    );

    const withGap = { ...base, memory: { ...base.memory, coveredBuckets: 59 } };
    expect(finding(withGap, 'gpu-memory')).toMatchObject({
      severity: 'warning',
      evidence:
        'The fullest GPU (gpu-node001 GPU 0) peaked at 8.8 GiB of 80.0 GiB (11%). Every GPU stayed below 15% of its memory in every bucket with memory telemetry. Each GPU has it for at least 59 of the 60 buckets of the scored window; the other buckets are not judged.',
    });
  });

  it('says how many GPUs were active at once only when every GPU reported in every bucket', () => {
    const complete = scored({ series: eightGpus((index) => (index < 4 ? 85 : 0)), allocatedGpus: 8 });
    expect(finding(complete, 'idle-gpus').evidence).toContain('At most 4 of them were active at the same time.');

    // GPU 7 reports only in the first bucket: it may have been active later.
    const series = eightGpus((index) => (index < 4 ? 85 : 0));
    series[7] = { ...series[7], peak: series[7].peak.map((value, index) => (index === 0 ? value : undefined)) };
    const gappy = scored({ series, allocatedGpus: 8 });
    expect(gappy.gpu.peakConcurrentActiveGpus).toBeUndefined();
    expect(finding(gappy, 'idle-gpus').evidence).not.toContain('at the same time');
  });

  it('flags idle GPU time from a quarter of the allocation on, and not below', () => {
    // 2 of 8 GPUs idle all the time: exactly 25%.
    const quarter = finding(scored({ series: eightGpus((index) => (index < 6 ? 90 : 0)), allocatedGpus: 8 }), 'idle-gpu-time');
    expect(quarter).toMatchObject({ severity: 'warning', label: 'Warning' });
    expect(quarter.evidence).toContain('2.00 of the 8.00 allocated GPU-hours were idle (25%).');

    // GPU 7 active in one of its 60 buckets: 119 of 480 GPU-buckets idle, 24.8%.
    const series = eightGpus((index) => (index < 6 ? 90 : 0));
    series[7] = { ...series[7], peak: series[7].peak.map((value, index) => (index === 0 ? 90 : value)) };
    const below = finding(scored({ series, allocatedGpus: 8 }), 'idle-gpu-time');
    expect(below).toMatchObject({ severity: 'ok', label: 'OK' });
    expect(below.advice).toBeUndefined();
    // The share is not rounded up to the limit it stays under.
    expect(below.evidence).toContain('1.98 of the 8.00 allocated GPU-hours were idle (24.7%).');
  });

  it('is inconclusive about idle GPU time when the time without telemetry could reach the limit', () => {
    // The last GPUs report in the first half of the job only, and are idle there.
    const firstHalfOnly = (from: number) =>
      eightGpus((index) => (index < from ? 90 : 0)).map((item, index) =>
        index < from ? item : { ...item, peak: item.peak.map((value, bucket) => (bucket < 30 ? value : undefined)) }
      );
    const definition = 'A GPU is idle in a 1m bucket when none of its samples exceeds 5% utilization.';

    // Two GPUs: 12.5% idle for sure, 25% if the time without telemetry was idle too.
    expect(finding(scored({ series: firstHalfOnly(6), allocatedGpus: 8 }), 'idle-gpu-time')).toEqual({
      id: 'idle-gpu-time',
      title: 'Idle GPU time',
      severity: 'unknown',
      label: 'Inconclusive',
      evidence: `1.00 of the 8.00 allocated GPU-hours were idle (13%). ${definition} 1.00 GPU-hours have no telemetry that belongs to the job and count as neither idle nor active. If they were idle, 25% of the allocation was: the 25% that marks idle time is neither reached nor ruled out.`,
    });

    // One GPU: 12.5% at most, so idle time under the limit is proven.
    expect(finding(scored({ series: firstHalfOnly(7), allocatedGpus: 8 }), 'idle-gpu-time')).toMatchObject({
      severity: 'ok',
      evidence: `0.50 of the 8.00 allocated GPU-hours were idle (6%). ${definition} 0.50 GPU-hours have no telemetry that belongs to the job and count as neither idle nor active.`,
    });
  });

  it('states bounds for a job on nodes that report more GPUs than it allocated', () => {
    const mostlyIdle = scored({ series: eightGpus((index) => (index === 0 ? 70 : 0)), allocatedGpus: 6, allocatedCpus: 12 });

    expect(finding(mostlyIdle, 'idle-gpus')).toMatchObject({
      severity: 'warning',
      evidence:
        "The job's nodes report 8 GPUs, but the job allocated 6, so the telemetry cannot tell which GPUs belong to the job. Only 1 of the 8 GPUs ever exceeded 5% utilization, so at least 5 of the 6 allocated GPUs never became active.",
      advice: 'The workload ran on at most 1 GPU. Request 1 instead of 6.',
    });
    expect(finding(mostlyIdle, 'idle-gpu-time')).toMatchObject({
      severity: 'warning',
      evidence: expect.stringContaining('At least 5.00 of the 6.00 allocated GPU-hours were idle (83%).'),
    });
    expect(finding(mostlyIdle, 'gpu-memory')).toMatchObject({ severity: 'unknown', label: 'Inconclusive' });
    expect(finding(mostlyIdle, 'input-pipeline')).toMatchObject({
      severity: 'unknown',
      label: 'Inconclusive',
      evidence: "The job's nodes report more GPUs than the job allocated, so GPU utilization cannot be attributed to the job.",
    });

    const covered = scored({ series: eightGpus((index) => (index < 5 ? 80 : 0)), allocatedGpus: 4, allocatedCpus: 8 });
    expect(finding(covered, 'idle-gpus')).toMatchObject({
      severity: 'unknown',
      label: 'Inconclusive',
      evidence: expect.stringContaining('5 GPUs on these nodes exceeded 5% utilization, which is enough to cover the allocation'),
    });
    expect(finding(covered, 'idle-gpus').advice).toBeUndefined();
    expect(finding(covered, 'idle-gpu-time')).toMatchObject({
      severity: 'unknown',
      label: 'Inconclusive',
      evidence: expect.stringContaining(
        'At least 0.0 of the 4.00 allocated GPU-hours were idle (0%). A GPU is idle in a 1m bucket when none of its samples exceeds 5% utilization. The nodes are shared with other jobs, so this is a lower bound: the 25% that marks idle time is neither reached nor ruled out.'
      ),
    });
  });

  it('explains a CPU-bound and an I/O-bound input pipeline with the measured numbers', () => {
    const cpuBound = finding(scored({ series: eightGpus(() => 30), allocatedGpus: 8, busyShare: 0.97, ioWaitShare: 0.005 }), 'input-pipeline');
    expect(cpuBound).toMatchObject({
      severity: 'warning',
      evidence: `${COMPARED} In 100% of these windows, the GPUs in use averaged under 50% utilization while at least 90% of the job's 16 CPUs were busy. While the GPUs were underused, GPU utilization averaged 30%, 15.5 of 16 CPUs were busy and 0.1 CPUs waited for I/O.`,
      advice: expect.stringContaining('Request more CPUs per GPU'),
    });

    const ioBound = finding(scored({ series: eightGpus(() => 25), allocatedGpus: 8, busyShare: 0.3, ioWaitShare: 0.2 }), 'input-pipeline');
    expect(ioBound).toMatchObject({
      severity: 'warning',
      evidence: `${COMPARED} In 100% of these windows, the GPUs in use averaged under 50% utilization while at least 10% of the job's CPU time waited for I/O. While the GPUs were underused, GPU utilization averaged 25%, 4.8 of 16 CPUs were busy and 3.2 CPUs waited for I/O.`,
      advice: expect.stringContaining('The GPUs wait for storage.'),
    });
  });

  it('states bounds when windows have incomplete telemetry, and says when the windows are a sample', () => {
    const means = 'While the GPUs were underused, GPU utilization averaged 30%, 15.5 of 16 CPUs were busy and 0.0 CPUs waited for I/O.';
    const base = scored({ series: eightGpus(() => 30), allocatedGpus: 8, busyShare: 0.97, ioWaitShare: 0 });
    const withGaps = { scoredWindows: 9, unscoredWindows: 3, coverage: 0.28 };

    const bound = { ...base, bottleneck: { ...base.bottleneck, ...withGaps, cpuStarvedShare: 0.75, cpuStarvedShareMax: 1 } };
    expect(finding(bound, 'input-pipeline')).toMatchObject({
      severity: 'warning',
      evidence: `CPU load and GPU utilization were compared in 12 windows of 5m, which cover 28% of the scored window. A GPU was in use in 9 of them, and 3 more have incomplete CPU or GPU telemetry. In at least 75% of these windows, the GPUs in use averaged under 50% utilization while at least 90% of the job's 16 CPUs were busy. ${means}`,
    });

    const clear = {
      ...base,
      bottleneck: {
        ...base.bottleneck,
        status: 'ok' as const,
        scoredWindows: 11,
        unscoredWindows: 1,
        cpuStarvedShare: 0,
        cpuStarvedShareMax: 1 / 12,
        ioStarvedShare: 0,
        ioStarvedShareMax: 1 / 12,
      },
    };
    expect(finding(clear, 'input-pipeline')).toMatchObject({
      severity: 'ok',
      evidence: `CPU load and GPU utilization were compared in 12 windows of 5m. A GPU was in use in 11 of them, and 1 more has incomplete CPU or GPU telemetry. In 100% of the windows with a GPU in use, the GPUs in use averaged under 50% utilization. Saturated CPUs coincided with that in at most 8% and high I/O wait in at most 8% of these windows, both under the 25% that marks a bottleneck. ${means}`,
    });
  });

  it('gives both advices when the CPUs are saturated and wait for I/O', () => {
    const base = scored({ series: eightGpus(() => 30), allocatedGpus: 8, busyShare: 0.97, ioWaitShare: 0 });
    const both = { ...base, bottleneck: { ...base.bottleneck, status: 'cpu-and-io-bound' as const, ioStarvedShare: 0.5 } };

    const result = finding(both, 'input-pipeline');
    expect(result.evidence).toContain("In 100% of these windows, the GPUs in use averaged under 50% utilization while at least 90% of the job's 16 CPUs were busy.");
    expect(result.evidence).toContain("In 50% of these windows, the GPUs in use averaged under 50% utilization while at least 10% of the job's CPU time waited for I/O.");
    expect(result.advice).toContain('Request more CPUs per GPU');
    expect(result.advice).toContain('The GPUs wait for storage.');
  });

  it('shows the CPU evidence without advice when underused GPUs have no CPU or I/O cause', () => {
    const result = finding(scored({ series: eightGpus(() => 30), allocatedGpus: 8, busyShare: 0.08, ioWaitShare: 0 }), 'input-pipeline');
    expect(result).toMatchObject({
      severity: 'ok',
      evidence: `${COMPARED} In 100% of the windows with a GPU in use, the GPUs in use averaged under 50% utilization. Saturated CPUs coincided with that in 0% and high I/O wait in 0% of these windows, both under the 25% that marks a bottleneck. While the GPUs were underused, GPU utilization averaged 30%, 1.3 of 16 CPUs were busy and 0.0 CPUs waited for I/O.`,
    });
    expect(result.advice).toBeUndefined();
  });

  it('does not blame a job for the CPU load of a node it shares', () => {
    const result = finding(scored({ series: eightGpus(() => 30), allocatedGpus: 8, busyShare: 0.95, ioWaitShare: 0, allocatedCpus: 8 }), 'input-pipeline');
    expect(result).toMatchObject({
      severity: 'unknown',
      label: 'Inconclusive',
      evidence: `The job holds 8 of the 16 CPUs of its nodes, so busy or waiting CPUs may belong to other jobs. ${COMPARED} In 100% of these windows, the GPUs in use averaged under 50% utilization while the node-wide load reached the job's CPU saturation level, and in 0% while it reached the job's I/O wait level. While the GPUs were underused, GPU utilization averaged 30%, 15.2 of the nodes' 16 CPUs were busy and 0.0 CPUs waited for I/O.`,
    });
    expect(result.advice).toBeUndefined();
  });

  it.each<[Partial<MemoryScore>, string, string]>([
    [{ status: 'no-data' }, 'No data', "DCGM_FI_DEV_FB_USED has no data for the job's nodes in the scored window."],
    [
      { status: 'capacity-unknown', highestPeakMiB: 65000 },
      'No data',
      "Peak memory use was 63.5 GiB, but DCGM_FI_DEV_FB_FREE has no data for the job's nodes, so the capacity is unknown.",
    ],
    [{ status: 'failed', error: 'Metrics query failed (HTTP 500)' }, 'Query failed', 'GPU memory was not scored. Metrics query failed (HTTP 500)'],
    [
      {
        status: 'inconclusive',
        reason: 'incomplete-data',
        gpusWithCapacity: 8,
        gpusCovered: 1,
        fullest: { instance: 'gpu-node001:9400', node: 'gpu-node001', gpu: '0', peakMiB: 4096, capacityMiB: 81920, share: 0.05 },
      },
      'Inconclusive',
      'The fullest GPU with memory telemetry (gpu-node001 GPU 0) peaked at 4.0 GiB of 80.0 GiB (5%), under the 15% below which memory use counts as low. But the memory telemetry covers 95% or more of the buckets of the scored window for only 1 of the 8 GPUs, so the memory use may have been higher where it is missing.',
    ],
  ])('says why GPU memory is not judged: %j', (memory, label, evidence) => {
    const result = scored({ series: eightGpus(() => 90), allocatedGpus: 8, overrides: { memory: { status: 'no-data', gpusWithCapacity: 0, gpusCovered: 0, ...memory } } });
    expect(finding(result, 'gpu-memory')).toMatchObject({ severity: 'unknown', label, evidence });
  });

  it.each<[Partial<BottleneckScore>, string, string]>([
    [{ status: 'no-data' }, 'No data', "node_cpu_seconds_total has no data for the job's nodes in the scored window."],
    [{ status: 'failed', error: 'Metrics query failed (HTTP 500)' }, 'Query failed', 'The CPU and I/O bottleneck was not scored. Metrics query failed (HTTP 500)'],
    [
      { status: 'inconclusive', reason: 'cpu-allocation-unknown', allocatedCpus: 0 },
      'Inconclusive',
      "The job's AllocTRES records no CPU count, so the node-wide CPU load cannot be compared with the job's allocation.",
    ],
    [
      { status: 'inconclusive', reason: 'cpu-telemetry-out-of-range' },
      'Inconclusive',
      "node_cpu_seconds_total does not add up to one second per second and CPU on the job's nodes, so it is not node_exporter's per-CPU counter and the CPU load cannot be scored.",
    ],
    [
      { status: 'inconclusive', reason: 'cpu-allocation-exceeds-nodes', allocatedCpus: 64, nodeCpus: 32 },
      'Inconclusive',
      "The job's AllocTRES records 64 CPUs, but its nodes report 32, so a part of the job's CPUs has no telemetry.",
    ],
    [
      { status: 'inconclusive', reason: 'no-io-wait-data', cpuStarvedShare: 0.1, cpuStarvedShareMax: 0.1 },
      'Inconclusive',
      `${COMPARED} Saturated CPUs coincided with underused GPUs in 10% of these windows, under the 25% that marks a bottleneck. I/O wait has no data (node_cpu_seconds_total with mode="iowait"), so an I/O bottleneck is not ruled out.`,
    ],
    [
      { status: 'inconclusive', reason: 'silent-cpu-nodes', silentNodes: ['gpu-node002'] },
      'Inconclusive',
      'Node gpu-node002 of the job reports no CPU telemetry (node_cpu_seconds_total) in the scored window, so the CPU load of the job is not known.',
    ],
    [
      { status: 'inconclusive', reason: 'silent-cpu-nodes', silentNodes: ['gpu-node002', 'gpu-node003'] },
      'Inconclusive',
      'Nodes gpu-node002 and gpu-node003 of the job report no CPU telemetry (node_cpu_seconds_total) in the scored window, so the CPU load of the job is not known.',
    ],
    [
      { status: 'inconclusive', reason: 'too-few-windows', windows: 3, coverage: 0.004 },
      'Inconclusive',
      'The CPU load is read in one window of 5m per bucket. This job has 3 windows, which cover 0.4% of the scored window: too little to judge a bottleneck.',
    ],
    [
      { status: 'inconclusive', reason: 'too-few-windows', windows: 1, coverage: 0.3 },
      'Inconclusive',
      'The CPU load is read in one window of 5m per bucket. This job has 1 window, which covers 30% of the scored window: too little to judge a bottleneck.',
    ],
    [
      { status: 'inconclusive', reason: 'no-window', windows: 0 },
      'Inconclusive',
      "No reading of the CPU load fits into the scored window: a reading takes 5m and begins at least 75 seconds after the job's start, so that it cannot include the CPU time of the job that ran on the nodes before.",
    ],
    [
      {
        status: 'inconclusive',
        reason: 'incomplete-telemetry',
        scoredWindows: 2,
        unscoredWindows: 2,
        earlyWindows: 1,
        windows: 4,
        cpuStarvedShare: 0,
        cpuStarvedShareMax: 0.5,
        ioStarvedShare: 0,
        ioStarvedShareMax: 0.5,
      },
      'Inconclusive',
      "CPU load and GPU utilization were compared in 4 windows of 5m. A GPU was in use in 2 of them, and 1 more has incomplete CPU or GPU telemetry. 1 more begins too soon after the job's start for the scrape interval of node_cpu_seconds_total: its CPU rate could include the job that ran on the nodes before. Saturated CPUs coincided with underused GPUs in 0% to 50% of these windows and high I/O wait in 0% to 50%, depending on what happened in the windows without complete telemetry. The 25% that marks a bottleneck is neither reached nor ruled out.",
    ],
    [
      {
        status: 'inconclusive',
        reason: 'incomplete-telemetry',
        scoredWindows: 7,
        unscoredWindows: 5,
        cpuStarvedShare: 1 / 12,
        cpuStarvedShareMax: 0.5,
        ioStarvedShare: 0,
        ioStarvedShareMax: 5 / 12,
      },
      'Inconclusive',
      'CPU load and GPU utilization were compared in 12 windows of 5m. A GPU was in use in 7 of them, and 5 more have incomplete CPU or GPU telemetry. Saturated CPUs coincided with underused GPUs in 8% to 50% of these windows and high I/O wait in 0% to 42%, depending on what happened in the windows without complete telemetry. The 25% that marks a bottleneck is neither reached nor ruled out.',
    ],
    [
      { status: 'inconclusive', reason: 'incomplete-telemetry', scoredWindows: 0, unscoredWindows: 2, earlyWindows: 2, windows: 2, cpuStarvedShareMax: 1, ioStarvedShareMax: 1 },
      'Inconclusive',
      "CPU load and GPU utilization were compared in 2 windows of 5m. A GPU was in use in 0 of them. 2 more begin too soon after the job's start for the scrape interval of node_cpu_seconds_total: their CPU rate could include the job that ran on the nodes before. Saturated CPUs coincided with underused GPUs in 0% to 100% of these windows and high I/O wait in 0% to 100%, depending on what happened in the windows without complete telemetry. The 25% that marks a bottleneck is neither reached nor ruled out.",
    ],
    [
      { status: 'not-applicable', reason: 'no-active-gpu' },
      'Not applicable',
      'No GPU was in use in the windows in which the CPU load is read, so there is no GPU load to pair the CPU load with.',
    ],
  ])('says why the bottleneck is not judged: %j', (bottleneck, label, evidence) => {
    const base = scored({ series: eightGpus(() => 90), allocatedGpus: 8 });
    const result = { ...base, bottleneck: { ...base.bottleneck, ...bottleneck } };
    expect(finding(result, 'input-pipeline')).toMatchObject({ severity: 'unknown', label, evidence });
  });

  it('uses the configured thresholds and metric names in the sentences', () => {
    const settings = { ...EFFICIENCY_DEFAULTS, idleGpuUtilizationPercent: 0.5, lowGpuMemoryPercent: 40, gpuMemoryUsedMetric: 'my_gpu_memory_used' };
    const base = scored({ series: eightGpus(() => 90), allocatedGpus: 8 });

    expect(finding({ ...base, settings }, 'idle-gpus').evidence).toContain('exceeded 0.5% utilization');
    expect(finding({ ...base, settings }, 'gpu-memory').evidence).toContain('Memory use counts as low under 40%.');
    expect(finding({ ...base, settings, memory: { status: 'no-data', gpusWithCapacity: 0, gpusCovered: 0 } }, 'gpu-memory').evidence).toContain('my_gpu_memory_used');
  });
});

describe('buildTiles', () => {
  it('summarizes GPU time, idle GPUs and memory', () => {
    const tiles = buildTiles(scored({ series: eightGpus((index) => (index < 4 ? 85 : 0)), allocatedGpus: 8, usedMiB: 9000 }));

    expect(tiles).toEqual([
      { id: 'time-in-use', label: 'GPU time in use', value: '50%', detail: '4.00 of 8.00 observed GPU-hours' },
      { id: 'idle-gpu-hours', label: 'Idle GPU-hours', value: '4.00', detail: 'of 8.00 allocated' },
      { id: 'never-active-gpus', label: 'Never-active GPUs', value: '4 of 8', detail: '8 GPUs reporting' },
      { id: 'peak-gpu-memory', label: 'Peak GPU memory', value: '11%', detail: '8.8 GiB of 80.0 GiB on the fullest GPU' },
    ]);
  });

  it('marks bounds and shows time without telemetry', () => {
    const shared = buildTiles(scored({ series: eightGpus((index) => (index === 0 ? 70 : 0)), allocatedGpus: 6, allocatedCpus: 12 }));
    expect(shared.map((tile) => tile.value)).toEqual(['≤ 17%', '≥ 5.00', '≥ 5 of 6', '73%']);

    expect(shared[3].detail).toBe("58.6 GiB of 80.0 GiB on the fullest GPU of the job's nodes, which may be another job's");

    // GPUs 4-7 report in the first half of the job only.
    const series = eightGpus((index) => (index < 4 ? 88 : 0)).map((item, index) =>
      index < 4 ? item : { ...item, peak: item.peak.map((value, bucket) => (bucket < 30 ? value : undefined)) }
    );
    const gaps = buildTiles(scored({ series, allocatedGpus: 8, overrides: { memory: { status: 'no-data', gpusWithCapacity: 0, gpusCovered: 0 } } }));
    expect(gaps[0]).toMatchObject({ value: '67%', detail: '4.00 of 6.00 observed GPU-hours' });
    expect(gaps[1]).toMatchObject({ value: '2.00', detail: 'of 8.00 allocated; 2.00 without telemetry' });
    expect(gaps[2]).toMatchObject({ value: '≥ 0 of 8', detail: '8 GPUs reporting, 4 with gaps' });
    expect(gaps[3]).toMatchObject({ value: 'No data' });
  });

  it('shows no number as the job own when the reporting GPUs cannot be matched to it', () => {
    const fewer = buildTiles(scored({ series: eightGpus(() => 0).slice(0, 4), allocatedGpus: 8 }));
    expect(fewer.map((tile) => tile.value)).toEqual(['Unknown', 'Unknown', 'Unknown', 'Unknown']);
    expect(fewer[2].detail).toBe('4 GPUs reporting, 8 allocated');
  });
});

describe('buildWindowNotes', () => {
  const base = scored({ series: eightGpus(() => 90), allocatedGpus: 8 });

  it('states the scored window', () => {
    expect(buildWindowNotes(base)).toEqual(['Scored window: 1h 0m in 60 buckets of 1m.']);
  });

  it('says that a running job is scored up to now, what is skipped, and what has no data', () => {
    const gappy = scored({
      series: eightGpus(() => 90).map((item) => ({ ...item, peak: item.peak.map((value, index) => (index < 30 ? undefined : value)) })),
      allocatedGpus: 8,
      overrides: { window: { ...window, running: true, runningLagSeconds: 120, skippedStartSeconds: 42, skippedEndSeconds: 17 } },
    });

    expect(buildWindowNotes(gappy)).toEqual([
      'Scored window: 1h 0m in 60 buckets of 1m.',
      'The job is still running: the scores cover the time up to 2m ago, when the newest samples have arrived, and will change.',
      'The first 42s and the last 17s of the job fill no whole bucket and are not scored.',
      'The GPU telemetry is complete in 30 of 60 buckets. In the others a GPU or a node did not report, for example because an exporter was down or the job is older than the metrics retention.',
    ]);
  });

  it('names only the end that is skipped', () => {
    expect(buildWindowNotes({ ...base, window: { ...window, skippedEndSeconds: 30 } })[1]).toBe(
      'The last 30s of the job fill no whole bucket and are not scored.'
    );
    expect(buildWindowNotes({ ...base, window: { ...window, skippedStartSeconds: 90 } })[1]).toBe(
      'The first 1m of the job fill no whole bucket and are not scored.'
    );
  });

  it('describes the window of a job without telemetry', () => {
    expect(buildWindowNotes({ kind: 'no-telemetry', window, settings: EFFICIENCY_DEFAULTS })).toEqual(['Scored window: 1h 0m in 60 buckets of 1m.']);
  });
});

describe('describeNotComputed', () => {
  it.each([
    [{ reason: 'disabled' as const }, 'Job efficiency is turned off for this cluster.'],
    [{ reason: 'no-datasource' as const }, 'The cluster has no metrics datasource configured.'],
    [{ reason: 'not-started' as const }, 'The job has not started.'],
    [
      { reason: 'no-gpus-allocated' as const },
      "The job's AllocTRES records no GPUs, so there is no GPU allocation to compare the telemetry with.",
    ],
    [
      { reason: 'suspended' as const, value: 600 },
      'The job was suspended for 10m of its run. A suspended job keeps its allocation but does not run, and its GPUs may run another job meanwhile. The plugin reads only the total time a job was suspended, not when it was suspended, so that time cannot be cut out of the telemetry and the job is not scored.',
    ],
    [
      { reason: 'suspended' as const },
      'The job is suspended, or was suspended and the total time is not available. A suspended job keeps its allocation but does not run, and its GPUs may run another job meanwhile. The plugin reads only the total time a job was suspended, not when it was suspended, so that time cannot be cut out of the telemetry and the job is not scored.',
    ],
    [
      { reason: 'past-time-limit' as const, value: 7 * 3600 },
      'slurmdbd records the job as running, 7h 0m past its time limit. Its end may be missing from the accounting database (a runaway job) and its nodes may run other jobs by now, so the job is not scored.',
    ],
    [{ reason: 'too-short' as const, value: 130 }, 'The job ran for 2m. Jobs shorter than 5m hold too few samples to score.'],
    [{ reason: 'too-short' as const, value: 45 }, 'The job ran for 45s. Jobs shorter than 5m hold too few samples to score.'],
    [
      { reason: 'too-large' as const, value: 32000 },
      "The job's nodes are expected to report about 32000 GPUs, more than the 24000 one scorecard reads.",
    ],
    [
      { reason: 'invalid-settings' as const, errors: ['GPU ID Label must be a Prometheus label name'] },
      "The cluster's efficiency settings are invalid: GPU ID Label must be a Prometheus label name.",
    ],
    [
      { reason: 'missing-gpu-label' as const },
      'DCGM_FI_DEV_GPU_UTIL has no "gpu" label on the job\'s nodes, so the GPUs of a node cannot be told apart. Set the GPU ID label in the cluster\'s efficiency settings.',
    ],
  ])('explains %j', (result, message) => {
    expect(describeNotComputed({ kind: 'not-computed', settings: EFFICIENCY_DEFAULTS, ...result })).toBe(message);
  });
});
