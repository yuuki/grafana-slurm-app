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
  listGpus,
  ScoredEfficiency,
} from './findings';
import { BottleneckScore, GpuBucketSeries, gpuKey, MemoryScore, scoreBottleneck, scoreGpus, scoreMemory } from './score';
import { EFFICIENCY_DEFAULTS } from './settings';
import { ScoredWindow } from './window';

const BUCKETS = 60;
const STEP = 60;

const window: ScoredWindow = {
  status: 'ok',
  running: false,
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

function memoryMaps(series: GpuBucketSeries[], usedMiB: number, capacityMiB = 81920): [Map<string, number>, Map<string, number>] {
  const keys = series.map((item) => gpuKey(item.instance, item.gpu));
  return [new Map(keys.map((key) => [key, usedMiB])), new Map(keys.map((key) => [key, capacityMiB - usedMiB]))];
}

/** An hour on one 16-CPU node; the job holds all of its CPUs unless told otherwise. */
function scored({
  series,
  allocatedGpus,
  usedMiB = 60000,
  busyShare = 0.5,
  ioWaitShare = 0.01,
  allocatedCpus = 16,
  overrides = {},
}: {
  series: GpuBucketSeries[];
  allocatedGpus: number;
  usedMiB?: number;
  busyShare?: number;
  ioWaitShare?: number;
  allocatedCpus?: number;
  overrides?: Partial<ScoredEfficiency>;
}): ScoredEfficiency {
  const gpuScore = scoreGpus(series, allocatedGpus, BUCKETS, STEP, EFFICIENCY_DEFAULTS.idleGpuUtilizationPercent);
  const memory = scoreMemory(gpuScore, ...memoryMaps(series, usedMiB), EFFICIENCY_DEFAULTS.lowGpuMemoryPercent);
  const fill = (value: number) => new Array<number>(BUCKETS).fill(value);
  const bottleneck = scoreBottleneck({
    series,
    gpuAttribution: gpuScore.attribution,
    bucketCount: BUCKETS,
    idleBaselinePercent: EFFICIENCY_DEFAULTS.idleGpuUtilizationPercent,
    idleCpus: fill(16 * (1 - busyShare - ioWaitShare)),
    ioWaitCpus: fill(16 * ioWaitShare),
    cpuCount: fill(16),
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
    const many = scoreGpus(
      [...eightGpus(() => 0), ...Array.from({ length: 8 }, (_, index) => gpu(String(index), 0, 'gpu-node002'))],
      16,
      BUCKETS,
      STEP,
      5
    ).gpus;
    expect(listGpus(many.slice(0, 3))).toBe('gpu-node001: GPU 0, 1, 2');
    expect(listGpus(many, 10)).toBe('gpu-node001: GPU 0, 1, 2, 3, 4, 5, 6, 7; gpu-node002: GPU 0, 1; and 6 more');
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
      '0.0 of 8.00 observed GPU-hours were idle (0%). A GPU is idle in a 1m bucket when none of its samples exceeds 5% utilization.'
    );
    expect(findings[2].evidence).toBe(
      'The fullest GPU (gpu-node001 GPU 0) peaked at 58.6 GiB of 80.0 GiB (73%). Memory use counts as low under 15%.'
    );
    expect(findings[3].evidence).toBe('The active GPUs averaged 50% utilization or more in all of the time with an active GPU.');
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
        '4.00 of 8.00 observed GPU-hours were idle (50%). A GPU is idle in a 1m bucket when none of its samples exceeds 5% utilization.',
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

  it('never calls missing telemetry idle', () => {
    const result = scored({ series: eightGpus((index) => (index < 4 ? 88 : undefined)), allocatedGpus: 8 });

    expect(finding(result, 'idle-gpus')).toMatchObject({
      severity: 'unknown',
      label: 'Inconclusive',
      evidence:
        'No GPU with telemetry stayed idle: 4 of the 8 allocated GPUs exceeded 5% utilization. 4 allocated GPUs have no telemetry.',
    });
    expect(finding(result, 'idle-gpu-time').evidence).toBe(
      '0.0 of 4.00 observed GPU-hours were idle (0%). A GPU is idle in a 1m bucket when none of its samples exceeds 5% utilization. 4.00 allocated GPU-hours have no telemetry and count as neither idle nor active.'
    );
  });

  it('states bounds for a job on nodes that report more GPUs than it allocated', () => {
    const mostlyIdle = scored({ series: eightGpus((index) => (index === 0 ? 70 : 0)), allocatedGpus: 6, allocatedCpus: 12 });

    expect(finding(mostlyIdle, 'idle-gpus')).toMatchObject({
      severity: 'warning',
      evidence:
        "The job's nodes report 8 GPUs, but the job allocated 6, so the telemetry cannot tell which GPUs belong to the job. Only 1 of the 8 GPUs ever exceeded 5% utilization, so at least 5 of the 6 allocated GPUs never became active.",
      advice: 'The workload ran on at most 1 GPU. Request 1 instead of 6.',
    });
    expect(finding(mostlyIdle, 'idle-gpu-time').evidence).toContain('At least 5.00 of 6.00 observed GPU-hours were idle (83%).');
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
      evidence: expect.stringContaining('The nodes are shared with other jobs, so this is a lower bound.'),
    });
  });

  it('explains a CPU-bound and an I/O-bound input pipeline with the measured numbers', () => {
    const cpuBound = finding(scored({ series: eightGpus(() => 30), allocatedGpus: 8, busyShare: 0.97, ioWaitShare: 0.005 }), 'input-pipeline');
    expect(cpuBound).toMatchObject({
      severity: 'warning',
      evidence:
        "In 100% of the time with an active GPU, the active GPUs averaged under 50% utilization while at least 90% of the job's 16 CPUs were busy. While the GPUs were underused, GPU utilization averaged 30%, 15.5 of 16 CPUs were busy and 0.1 CPUs waited for I/O.",
      advice: expect.stringContaining('Request more CPUs per GPU'),
    });

    const ioBound = finding(scored({ series: eightGpus(() => 25), allocatedGpus: 8, busyShare: 0.3, ioWaitShare: 0.2 }), 'input-pipeline');
    expect(ioBound).toMatchObject({
      severity: 'warning',
      evidence:
        "In 100% of the time with an active GPU, the active GPUs averaged under 50% utilization while at least 10% of the job's CPU time waited for I/O. While the GPUs were underused, GPU utilization averaged 25%, 4.8 of 16 CPUs were busy and 3.2 CPUs waited for I/O.",
      advice: expect.stringContaining('The GPUs wait for storage.'),
    });
  });

  it('shows the CPU evidence without advice when underused GPUs have no CPU or I/O cause', () => {
    const result = finding(scored({ series: eightGpus(() => 30), allocatedGpus: 8, busyShare: 0.08, ioWaitShare: 0 }), 'input-pipeline');
    expect(result).toMatchObject({
      severity: 'ok',
      evidence:
        'In 100% of the time with an active GPU, the active GPUs averaged under 50% utilization. Saturated CPUs coincided with that in 0% and high I/O wait in 0% of the time, both under the 25% that marks a bottleneck. While the GPUs were underused, GPU utilization averaged 30%, 1.3 of 16 CPUs were busy and 0.0 CPUs waited for I/O.',
    });
    expect(result.advice).toBeUndefined();
  });

  it('does not blame a job for the CPU load of a node it shares', () => {
    const result = finding(scored({ series: eightGpus(() => 30), allocatedGpus: 8, busyShare: 0.95, ioWaitShare: 0, allocatedCpus: 8 }), 'input-pipeline');
    expect(result).toMatchObject({
      severity: 'unknown',
      label: 'Inconclusive',
      evidence: expect.stringContaining("The job holds 8 of the 16 CPUs of its nodes, so busy or waiting CPUs may belong to other jobs."),
    });
    expect(result.evidence).toContain("15.2 of the nodes' 16 CPUs were busy");
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
        gpusWithCapacity: 1,
        fullest: { instance: 'gpu-node001:9400', node: 'gpu-node001', gpu: '0', peakMiB: 4096, capacityMiB: 81920, share: 0.05 },
      },
      'Inconclusive',
      'The fullest GPU with memory telemetry (gpu-node001 GPU 0) peaked at 4.0 GiB of 80.0 GiB (5%), under the 15% below which memory use counts as low. But only 1 GPU of the job has memory telemetry, so another one may be fuller.',
    ],
  ])('says why GPU memory is not judged: %j', (memory, label, evidence) => {
    const result = scored({ series: eightGpus(() => 90), allocatedGpus: 8, overrides: { memory: { status: 'no-data', gpusWithCapacity: 0, ...memory } } });
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
      { status: 'inconclusive', reason: 'no-io-wait-data', cpuStarvedShare: 0.1 },
      'Inconclusive',
      'Saturated CPUs coincided with underused GPUs in 10% of the time with an active GPU, under the 25% that marks a bottleneck. I/O wait has no data (node_cpu_seconds_total with mode="iowait"), so an I/O bottleneck is not ruled out.',
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
    expect(finding({ ...base, settings, memory: { status: 'no-data', gpusWithCapacity: 0 } }, 'gpu-memory').evidence).toContain('my_gpu_memory_used');
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

    const partial = buildTiles(
      scored({ series: eightGpus((index) => (index < 4 ? 88 : undefined)), allocatedGpus: 8, overrides: { memory: { status: 'no-data', gpusWithCapacity: 0 } } })
    );
    expect(partial[1]).toMatchObject({ value: '0.0', detail: 'of 8.00 allocated; 4.00 without telemetry' });
    expect(partial[2]).toMatchObject({ value: '0 of 8', detail: '4 GPUs without telemetry' });
    expect(partial[3]).toMatchObject({ value: 'No data' });
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
      overrides: { window: { ...window, running: true, skippedStartSeconds: 42, skippedEndSeconds: 17 } },
    });

    expect(buildWindowNotes(gappy)).toEqual([
      'Scored window: 1h 0m in 60 buckets of 1m.',
      'The job is still running: the scores cover the time up to now and will change.',
      'The first 42s and the last 17s of the job fill no whole bucket and are not scored.',
      'GPU telemetry covers 30 of 60 buckets. The rest has no data, for example because the job is older than the metrics retention.',
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
    [{ reason: 'no-datasource' as const }, 'The cluster has no metrics datasource configured.'],
    [{ reason: 'not-started' as const }, 'The job has not started.'],
    [
      { reason: 'no-gpus-allocated' as const },
      "The job's AllocTRES records no GPUs, so there is no GPU allocation to compare the telemetry with.",
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
