import {
  accumulateGpuTime,
  BottleneckInput,
  GpuBucketSeries,
  gpuKey,
  scoreBottleneck,
  scoreGpus,
  scoreMemory,
} from './score';

const NONE = undefined;

/** A GPU on node "n1" whose bucket means equal its bucket peaks unless given. */
function gpu(id: string, peak: Array<number | undefined>, mean: Array<number | undefined> = peak, node = 'n1'): GpuBucketSeries {
  return { instance: `${node}:9400`, node, gpu: id, peak, mean };
}

function repeat<T>(value: T, count: number): T[] {
  return new Array<T>(count).fill(value);
}

describe('accumulateGpuTime', () => {
  it.each([
    {
      name: 'every GPU observed and active',
      buckets: [{ seconds: 60, observed: 4, active: 4 }],
      allocated: 4,
      want: { allocatedSeconds: 240, activeSeconds: 240, idleSeconds: 0, unobservedSeconds: 0, bounded: false },
    },
    {
      name: 'idle GPUs count as idle',
      buckets: [{ seconds: 60, observed: 4, active: 1 }],
      allocated: 4,
      want: { allocatedSeconds: 240, activeSeconds: 60, idleSeconds: 180, unobservedSeconds: 0, bounded: false },
    },
    {
      name: 'GPUs without telemetry are unobserved, not idle',
      buckets: [{ seconds: 60, observed: 1, active: 1 }],
      allocated: 4,
      want: { allocatedSeconds: 240, activeSeconds: 60, idleSeconds: 0, unobservedSeconds: 180, bounded: false },
    },
    {
      name: 'a bucket without any telemetry is unobserved',
      buckets: [{ seconds: 60, observed: 0, active: 0 }],
      allocated: 4,
      want: { allocatedSeconds: 240, activeSeconds: 0, idleSeconds: 0, unobservedSeconds: 240, bounded: false },
    },
    {
      name: 'more GPUs reporting than allocated: idle time is a lower bound',
      buckets: [{ seconds: 60, observed: 8, active: 1 }],
      allocated: 4,
      want: { allocatedSeconds: 240, activeSeconds: 60, idleSeconds: 180, unobservedSeconds: 0, bounded: true },
    },
    {
      name: 'more GPUs reporting than allocated and enough of them active: nothing provably idle',
      buckets: [{ seconds: 60, observed: 8, active: 6 }],
      allocated: 4,
      want: { allocatedSeconds: 240, activeSeconds: 240, idleSeconds: 0, unobservedSeconds: 0, bounded: true },
    },
    {
      name: 'buckets of different lengths',
      buckets: [
        { seconds: 30, observed: 2, active: 2 },
        { seconds: 90, observed: 2, active: 0 },
      ],
      allocated: 2,
      want: { allocatedSeconds: 240, activeSeconds: 60, idleSeconds: 180, unobservedSeconds: 0, bounded: false },
    },
  ])('$name', ({ buckets, allocated, want }) => {
    const time = accumulateGpuTime(buckets, allocated);
    expect(time).toEqual(want);
    expect(time.activeSeconds + time.idleSeconds + time.unobservedSeconds).toBe(time.allocatedSeconds);
  });
});

describe('scoreGpus', () => {
  it('finds the GPUs that never exceeded the idle baseline', () => {
    const score = scoreGpus(
      [gpu('0', [90, 95, 80, 85]), gpu('1', [70, 0, 0, 60]), gpu('2', [0, 3, 5, 0]), gpu('3', [0, 0, 0, 0])],
      4,
      4,
      60,
      5
    );

    expect(score).toMatchObject({
      allocatedGpus: 4,
      observedGpus: 4,
      attribution: 'exact',
      activeGpus: 2,
      idleGpus: 2,
      partialGpus: 0,
      neverActiveGpus: 2,
      missingGpus: 0,
      peakConcurrentActiveGpus: 2,
      observedBuckets: 4,
    });
    // 16 GPU-buckets of 60 s: GPU 0 active 4, GPU 1 active 2.
    expect(score.time).toEqual({ allocatedSeconds: 960, activeSeconds: 360, idleSeconds: 600, unobservedSeconds: 0, bounded: false });
    expect(score.timeInUseShare).toBeCloseTo(0.375);
    // Mean of the six active GPU-buckets: 90, 95, 80, 85, 70, 60.
    expect(score.meanUtilizationWhileActive).toBeCloseTo(80);
    // Idle GPUs first, then active ones, each in GPU order.
    expect(score.gpus.map((item) => [item.gpu, item.activity])).toEqual([
      ['2', 'idle'],
      ['3', 'idle'],
      ['0', 'active'],
      ['1', 'active'],
    ]);
    expect(score.gpus[0]).toMatchObject({ peakUtilization: 5, meanUtilization: 2, observedBuckets: 4, activeBuckets: 0 });
  });

  it('treats the idle baseline as inclusive: only a sample above it is activity', () => {
    expect(scoreGpus([gpu('0', [5, 5])], 1, 2, 60, 5).idleGpus).toBe(1);
    expect(scoreGpus([gpu('0', [5, 5.1])], 1, 2, 60, 5).idleGpus).toBe(0);
    expect(scoreGpus([gpu('0', [0, 0])], 1, 2, 60, 0).idleGpus).toBe(1);
    expect(scoreGpus([gpu('0', [0, 1])], 1, 2, 60, 0).activeGpus).toBe(1);
  });

  it('uses the bucket peak, not the mean, to decide activity', () => {
    const score = scoreGpus([gpu('0', [40], [2])], 1, 1, 60, 5);
    expect(score.activeGpus).toBe(1);
    expect(score.gpus[0].meanUtilization).toBe(2);
  });

  it('counts allocated GPUs without telemetry as missing, never as idle', () => {
    const score = scoreGpus([gpu('0', [90, 90]), gpu('1', [0, 0])], 4, 2, 60, 5);

    expect(score).toMatchObject({ attribution: 'partial', observedGpus: 2, missingGpus: 2, idleGpus: 1, neverActiveGpus: 1 });
    expect(score.time).toEqual({ allocatedSeconds: 480, activeSeconds: 120, idleSeconds: 120, unobservedSeconds: 240, bounded: false });
    // Unobserved time is in neither the numerator nor the denominator.
    expect(score.timeInUseShare).toBeCloseTo(0.5);
  });

  it('does not call a GPU idle that reported in too few buckets', () => {
    const score = scoreGpus([gpu('0', [90, 90, 90, 90]), gpu('1', [0, NONE, NONE, NONE]), gpu('2', [0, 0, NONE, NONE])], 3, 4, 60, 5);

    expect(score.gpus.map((item) => [item.gpu, item.activity])).toEqual([
      ['2', 'idle'],
      ['1', 'partial'],
      ['0', 'active'],
    ]);
    expect(score).toMatchObject({ idleGpus: 1, partialGpus: 1, neverActiveGpus: 1 });
    // GPU 1: one idle bucket, three unobserved. GPU 2: two and two.
    expect(score.time).toEqual({ allocatedSeconds: 720, activeSeconds: 240, idleSeconds: 180, unobservedSeconds: 300, bounded: false });
  });

  it('judges coverage against the buckets in which any GPU reported (metrics retention)', () => {
    // No GPU has data for the first half of the job.
    const score = scoreGpus([gpu('0', [NONE, NONE, 90, 90]), gpu('1', [NONE, NONE, 0, 0])], 2, 4, 60, 5);

    expect(score.observedBuckets).toBe(2);
    expect(score.gpus.map((item) => item.activity)).toEqual(['idle', 'active']);
    expect(score.time).toEqual({ allocatedSeconds: 480, activeSeconds: 120, idleSeconds: 120, unobservedSeconds: 240, bounded: false });
  });

  it('counts an active GPU as active however little it reported', () => {
    const score = scoreGpus([gpu('0', [NONE, NONE, NONE, 50]), gpu('1', [0, 0, 0, 0])], 2, 4, 60, 5);
    expect(score.gpus.map((item) => [item.gpu, item.activity])).toEqual([
      ['1', 'idle'],
      ['0', 'active'],
    ]);
  });

  it('gives bounds when the nodes report more GPUs than the job allocated', () => {
    const idle = [0, 0];
    const score = scoreGpus(
      [gpu('0', [80, 80]), gpu('1', idle), gpu('2', idle), gpu('3', idle), gpu('4', idle), gpu('5', idle), gpu('6', idle), gpu('7', idle)],
      6,
      2,
      60,
      5
    );

    expect(score).toMatchObject({
      attribution: 'shared',
      observedGpus: 8,
      activeGpus: 1,
      idleGpus: 7,
      // At most one of the six allocated GPUs was ever active.
      neverActiveGpus: 5,
      peakConcurrentActiveGpus: 1,
      missingGpus: 0,
    });
    expect(score.time).toEqual({ allocatedSeconds: 720, activeSeconds: 120, idleSeconds: 600, unobservedSeconds: 0, bounded: true });
  });

  it('proves no idle GPU on shared nodes when enough GPUs were active', () => {
    const score = scoreGpus(
      [gpu('0', [80]), gpu('1', [80]), gpu('2', [80]), gpu('3', [80]), gpu('4', [60]), gpu('5', [0]), gpu('6', [0]), gpu('7', [0])],
      4,
      1,
      60,
      5
    );

    expect(score).toMatchObject({ attribution: 'shared', activeGpus: 5, neverActiveGpus: 0, peakConcurrentActiveGpus: 4 });
    expect(score.time.idleSeconds).toBe(0);
    expect(score.time.bounded).toBe(true);
  });

  it('does not count GPUs with too little data toward the lower bound on shared nodes', () => {
    const score = scoreGpus([gpu('0', [80, 80, 80, 80]), gpu('1', [0, NONE, NONE, NONE]), gpu('2', [0, 0, 0, 0])], 2, 4, 60, 5);
    // 2 allocated - 1 active - 1 partial: nothing is provably idle.
    expect(score).toMatchObject({ attribution: 'shared', partialGpus: 1, neverActiveGpus: 0 });
  });

  it('drops series without a single sample and reports nothing observed', () => {
    const score = scoreGpus([gpu('0', [NONE, NONE])], 2, 2, 60, 5);

    expect(score).toMatchObject({ observedGpus: 0, attribution: 'partial', missingGpus: 2, observedBuckets: 0 });
    expect(score.timeInUseShare).toBeUndefined();
    expect(score.meanUtilizationWhileActive).toBeUndefined();
    expect(score.time).toEqual({ allocatedSeconds: 240, activeSeconds: 0, idleSeconds: 0, unobservedSeconds: 240, bounded: false });
  });

  it('orders GPUs by node and numeric GPU ID', () => {
    const score = scoreGpus(
      [gpu('10', [90], [90], 'n2'), gpu('2', [90], [90], 'n2'), gpu('0', [90], [90], 'n10'), gpu('1', [90], [90], 'n2')],
      4,
      1,
      60,
      5
    );
    expect(score.gpus.map((item) => `${item.node}/${item.gpu}`)).toEqual(['n2/1', 'n2/2', 'n2/10', 'n10/0']);
  });
});

describe('scoreMemory', () => {
  const twoActive = () => scoreGpus([gpu('0', [90]), gpu('1', [90])], 2, 1, 60, 5);
  const mib = (entries: Array<[string, number]>) => new Map(entries.map(([id, value]) => [gpuKey('n1:9400', id), value]));

  it('flags a job whose fullest GPU stayed under the threshold', () => {
    const gpus = twoActive();
    const score = scoreMemory(gpus, mib([['0', 8192], ['1', 4096]]), mib([['0', 73728], ['1', 77824]]), 15);

    expect(score.status).toBe('low');
    expect(score.fullest).toEqual({ instance: 'n1:9400', node: 'n1', gpu: '0', peakMiB: 8192, capacityMiB: 81920, share: 0.1 });
    expect(score.gpusWithCapacity).toBe(2);
    // The evidence rows carry each GPU's memory.
    expect(gpus.gpus.map((item) => [item.memoryPeakMiB, item.memoryCapacityMiB])).toEqual([
      [8192, 81920],
      [4096, 81920],
    ]);
  });

  it('is ok when the fullest GPU reached the threshold, and the threshold itself is not low', () => {
    expect(scoreMemory(twoActive(), mib([['0', 70000], ['1', 100]]), mib([['0', 11920], ['1', 81820]]), 15).status).toBe('ok');
    expect(scoreMemory(twoActive(), mib([['0', 15], ['1', 1]]), mib([['0', 85], ['1', 99]]), 15).status).toBe('ok');
  });

  it('cannot tell which GPU is the job own on shared nodes, unless even the fullest is low', () => {
    const shared = () => scoreGpus([gpu('0', [90]), gpu('1', [90]), gpu('2', [90])], 2, 1, 60, 5);
    const free = mib([['0', 50], ['1', 50], ['2', 50]]);

    expect(scoreMemory(shared(), mib([['0', 50], ['1', 5], ['2', 5]]), free, 15)).toMatchObject({ status: 'inconclusive', reason: 'shared-gpus' });
    // The job's GPUs cannot be fuller than the fullest GPU of the nodes.
    expect(scoreMemory(shared(), mib([['0', 5], ['1', 5], ['2', 5]]), free, 15).status).toBe('low');
  });

  it('does not report low memory when a GPU has no memory telemetry', () => {
    const score = scoreMemory(twoActive(), mib([['0', 5]]), mib([['0', 95]]), 15);
    expect(score).toMatchObject({ status: 'inconclusive', reason: 'incomplete-data', gpusWithCapacity: 1 });
  });

  it('does not report low memory when an allocated GPU has no telemetry at all', () => {
    const partial = scoreGpus([gpu('0', [90])], 2, 1, 60, 5);
    expect(scoreMemory(partial, mib([['0', 5]]), mib([['0', 95]]), 15)).toMatchObject({ status: 'inconclusive', reason: 'incomplete-data' });
    // A GPU that is known to be full settles it without the missing one.
    expect(scoreMemory(partial, mib([['0', 90]]), mib([['0', 10]]), 15).status).toBe('ok');
  });

  it('reports an unknown capacity when only the used metric has data', () => {
    const score = scoreMemory(twoActive(), mib([['0', 65000], ['1', 1000]]), new Map(), 15);
    expect(score).toMatchObject({ status: 'capacity-unknown', highestPeakMiB: 65000, gpusWithCapacity: 0 });
    expect(score.fullest).toBeUndefined();
  });

  it('reports no data when the memory metric returns nothing', () => {
    expect(scoreMemory(twoActive(), new Map(), new Map(), 15).status).toBe('no-data');
  });

  it('does not apply when no GPU was active', () => {
    const idle = scoreGpus([gpu('0', [0]), gpu('1', [0])], 2, 1, 60, 5);
    expect(scoreMemory(idle, mib([['0', 3], ['1', 3]]), mib([['0', 81917], ['1', 81917]]), 15).status).toBe('not-applicable');
  });

  it('ignores a GPU whose capacity would be zero', () => {
    const score = scoreMemory(twoActive(), mib([['0', 0], ['1', 0]]), mib([['0', 0], ['1', 0]]), 15);
    expect(score.status).toBe('capacity-unknown');
  });
});

describe('scoreBottleneck', () => {
  const BUCKETS = 4;

  /** One node of 16 CPUs held entirely by the job, 8 GPUs at the given utilization. */
  function input(overrides: Partial<BottleneckInput> & { utilization?: number[] } = {}): BottleneckInput {
    const { utilization = repeat(30, BUCKETS), ...rest } = overrides;
    return {
      series: [gpu('0', utilization), gpu('1', utilization)],
      gpuAttribution: 'exact',
      bucketCount: BUCKETS,
      idleBaselinePercent: 5,
      idleCpus: repeat(8, BUCKETS),
      ioWaitCpus: repeat(0, BUCKETS),
      cpuCount: repeat(16, BUCKETS),
      allocatedCpus: 16,
      ...rest,
    };
  }

  it('is ok when underused GPUs meet neither busy CPUs nor I/O wait', () => {
    expect(scoreBottleneck(input())).toMatchObject({
      status: 'ok',
      cpuAttribution: 'exclusive',
      nodeCpus: 16,
      scoredBuckets: 4,
      ioScoredBuckets: 4,
      lowGpuShare: 1,
      cpuStarvedShare: 0,
      ioStarvedShare: 0,
      meanGpuUtilizationWhileLow: 30,
      meanBusyCpusWhileLow: 8,
      meanIoWaitCpusWhileLow: 0,
    });
  });

  it('is ok when the GPUs are well used, whatever the CPUs do', () => {
    const score = scoreBottleneck(input({ utilization: repeat(90, BUCKETS), idleCpus: repeat(0, BUCKETS) }));
    expect(score).toMatchObject({ status: 'ok', lowGpuShare: 0, cpuStarvedShare: 0 });
    expect(score.meanGpuUtilizationWhileLow).toBeUndefined();
  });

  it('reports a CPU bottleneck when underused GPUs coincide with saturated CPUs', () => {
    // 16 CPUs, 1.6 idle: 14.4 busy, exactly the 90% that counts as saturated.
    expect(scoreBottleneck(input({ idleCpus: repeat(1.6, BUCKETS) }))).toMatchObject({
      status: 'cpu-bound',
      cpuStarvedShare: 1,
      ioStarvedShare: 0,
      meanBusyCpusWhileLow: 14.4,
    });
    expect(scoreBottleneck(input({ idleCpus: repeat(1.7, BUCKETS) })).status).toBe('ok');
  });

  it('reports an I/O bottleneck when underused GPUs coincide with I/O wait, and does not count waiting as busy', () => {
    // 16 CPUs: 1.6 wait for I/O (10%), 1 is idle. Busy is 13.4, under 90%.
    expect(scoreBottleneck(input({ idleCpus: repeat(1, BUCKETS), ioWaitCpus: repeat(1.6, BUCKETS) }))).toMatchObject({
      status: 'io-bound',
      cpuStarvedShare: 0,
      ioStarvedShare: 1,
      meanBusyCpusWhileLow: 13.4,
      meanIoWaitCpusWhileLow: 1.6,
    });
  });

  it('reports both when each coincides in at least a quarter of the time', () => {
    const score = scoreBottleneck(input({ idleCpus: [0, 12, 12, 12], ioWaitCpus: [0, 0, 0, 4] }));
    expect(score).toMatchObject({ status: 'cpu-and-io-bound', cpuStarvedShare: 0.25, ioStarvedShare: 0.25 });
  });

  it('needs the coincidence in a quarter of the time with an active GPU', () => {
    const idleCpus = [0, ...repeat(8, 7)];
    const eight = { bucketCount: 8, cpuCount: repeat(16, 8), ioWaitCpus: repeat(0, 8), utilization: repeat(30, 8) };
    expect(scoreBottleneck(input({ ...eight, idleCpus }))).toMatchObject({ status: 'ok', cpuStarvedShare: 0.125 });
    expect(scoreBottleneck(input({ ...eight, idleCpus: [0, 0, ...repeat(8, 6)] }))).toMatchObject({ status: 'cpu-bound', cpuStarvedShare: 0.25 });
  });

  it('only pairs the CPU load with buckets in which a GPU was active', () => {
    // GPUs idle in the first half (a CPU-only phase with saturated CPUs).
    const score = scoreBottleneck(input({ utilization: [0, 0, 90, 90], idleCpus: [0, 0, 8, 8] }));
    expect(score).toMatchObject({ status: 'ok', scoredBuckets: 2, lowGpuShare: 0 });
  });

  it('averages the utilization over the active GPUs only', () => {
    const score = scoreBottleneck(
      input({ series: [gpu('0', repeat(90, BUCKETS)), gpu('1', repeat(0, BUCKETS))], idleCpus: repeat(0, BUCKETS) })
    );
    // The idle GPU belongs to the idle GPU finding, not to this one.
    expect(score).toMatchObject({ status: 'ok', lowGpuShare: 0 });
  });

  it('cannot attribute busy CPUs on nodes the job shares, but idle CPUs clear the job', () => {
    // The job holds 4 of 16 CPUs: 3.6 busy CPUs would saturate it.
    const shared = { allocatedCpus: 4 };
    expect(scoreBottleneck(input({ ...shared, idleCpus: repeat(4, BUCKETS) }))).toMatchObject({
      status: 'inconclusive',
      reason: 'shared-cpus',
      cpuAttribution: 'shared',
      cpuStarvedShare: 1,
    });
    expect(scoreBottleneck(input({ ...shared, idleCpus: repeat(13, BUCKETS) }))).toMatchObject({
      status: 'ok',
      cpuAttribution: 'shared',
      cpuStarvedShare: 0,
    });
  });

  it('is inconclusive without a CPU allocation', () => {
    expect(scoreBottleneck(input({ allocatedCpus: 0, idleCpus: repeat(0, BUCKETS) }))).toMatchObject({
      status: 'inconclusive',
      reason: 'cpu-allocation-unknown',
      cpuAttribution: 'unknown',
    });
  });

  it('is inconclusive when the GPUs cannot be attributed to the job', () => {
    expect(scoreBottleneck(input({ gpuAttribution: 'shared', idleCpus: repeat(0, BUCKETS) }))).toMatchObject({
      status: 'inconclusive',
      reason: 'shared-gpus',
      scoredBuckets: 0,
    });
  });

  it('reports no data without CPU telemetry', () => {
    expect(scoreBottleneck(input({ idleCpus: [], ioWaitCpus: [], cpuCount: [] }))).toMatchObject({ status: 'no-data', nodeCpus: undefined });
  });

  it('does not rule out an I/O bottleneck without I/O wait telemetry', () => {
    expect(scoreBottleneck(input({ ioWaitCpus: [] }))).toMatchObject({ status: 'inconclusive', reason: 'no-io-wait-data', ioScoredBuckets: 0 });
    // A CPU bottleneck is still reported.
    expect(scoreBottleneck(input({ ioWaitCpus: [], idleCpus: repeat(0, BUCKETS) })).status).toBe('cpu-bound');
  });

  it('skips buckets without CPU telemetry', () => {
    const score = scoreBottleneck(input({ idleCpus: [NONE, NONE, 0, 0], cpuCount: [NONE, NONE, 16, 16] }));
    expect(score).toMatchObject({ status: 'cpu-bound', scoredBuckets: 2, cpuStarvedShare: 1 });
  });

  it('does not apply when no GPU was active while CPU telemetry was available', () => {
    expect(scoreBottleneck(input({ utilization: repeat(0, BUCKETS) }))).toMatchObject({ status: 'not-applicable', reason: 'no-active-gpu' });
  });

  it('takes the node CPU count from the bucket in which the most CPUs reported', () => {
    const score = scoreBottleneck(input({ cpuCount: [16, 32, 32, 16], idleCpus: [8, 16, 16, 8], allocatedCpus: 32 }));
    expect(score).toMatchObject({ nodeCpus: 32, cpuAttribution: 'exclusive' });
  });

  it('refuses CPU telemetry that is not a per-CPU counter', () => {
    // One series per node whose idle rate is 64 CPU-seconds per second.
    expect(scoreBottleneck(input({ cpuCount: repeat(1, BUCKETS), idleCpus: repeat(64, BUCKETS), allocatedCpus: 128 }))).toMatchObject({
      status: 'inconclusive',
      reason: 'cpu-telemetry-out-of-range',
    });
  });
});
