import {
  accumulateGpuTime,
  attributeGpus,
  BottleneckInput,
  GpuBucketSeries,
  gpuKey,
  GpuScore,
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

/** Scores 60 s buckets with a 5% idle baseline. The job's nodes default to the nodes of the series. */
function score(
  series: GpuBucketSeries[],
  allocatedGpus: number,
  options: { jobNodes?: string[]; idleBaselinePercent?: number } = {}
): GpuScore {
  return scoreGpus({
    series,
    jobNodes: options.jobNodes ?? [...new Set(series.map((item) => item.node))],
    allocatedGpus,
    bucketCount: series[0]?.peak.length ?? 0,
    stepSeconds: 60,
    idleBaselinePercent: options.idleBaselinePercent ?? 5,
  });
}

describe('accumulateGpuTime', () => {
  it.each([
    {
      name: 'every GPU observed and active',
      attribution: 'exact' as const,
      buckets: [{ seconds: 60, observed: 4, active: 4, complete: true }],
      allocated: 4,
      want: { allocatedSeconds: 240, activeSeconds: 240, idleSeconds: 0, unobservedSeconds: 0, bounded: false },
    },
    {
      name: 'idle GPUs count as idle',
      attribution: 'exact' as const,
      buckets: [{ seconds: 60, observed: 4, active: 1, complete: true }],
      allocated: 4,
      want: { allocatedSeconds: 240, activeSeconds: 60, idleSeconds: 180, unobservedSeconds: 0, bounded: false },
    },
    {
      name: 'GPUs without telemetry are unobserved, not idle',
      attribution: 'exact' as const,
      buckets: [{ seconds: 60, observed: 1, active: 1, complete: false }],
      allocated: 4,
      want: { allocatedSeconds: 240, activeSeconds: 60, idleSeconds: 0, unobservedSeconds: 180, bounded: false },
    },
    {
      name: 'a bucket without any telemetry is unobserved',
      attribution: 'exact' as const,
      buckets: [{ seconds: 60, observed: 0, active: 0, complete: false }],
      allocated: 4,
      want: { allocatedSeconds: 240, activeSeconds: 0, idleSeconds: 0, unobservedSeconds: 240, bounded: false },
    },
    {
      name: 'shared nodes, every GPU reporting: idle time is a lower bound',
      attribution: 'shared' as const,
      buckets: [{ seconds: 60, observed: 8, active: 1, complete: true }],
      allocated: 4,
      want: { allocatedSeconds: 240, activeSeconds: 60, idleSeconds: 180, unobservedSeconds: 0, bounded: true },
    },
    {
      name: 'shared nodes and enough GPUs active: nothing provably idle',
      attribution: 'shared' as const,
      buckets: [{ seconds: 60, observed: 8, active: 6, complete: true }],
      allocated: 4,
      want: { allocatedSeconds: 240, activeSeconds: 240, idleSeconds: 0, unobservedSeconds: 0, bounded: true },
    },
    {
      // The reporting GPUs are not more than the job allocated, but they
      // need not be the job's: its GPUs may be the ones that do not report.
      name: 'shared nodes with a GPU or node not reporting: the bucket is unobserved, whatever the reporting GPUs did',
      attribution: 'shared' as const,
      buckets: [{ seconds: 60, observed: 4, active: 0, complete: false }],
      allocated: 4,
      want: { allocatedSeconds: 240, activeSeconds: 0, idleSeconds: 0, unobservedSeconds: 240, bounded: true },
    },
    {
      name: 'buckets of different lengths',
      attribution: 'exact' as const,
      buckets: [
        { seconds: 30, observed: 2, active: 2, complete: true },
        { seconds: 90, observed: 2, active: 0, complete: true },
      ],
      allocated: 2,
      want: { allocatedSeconds: 240, activeSeconds: 60, idleSeconds: 180, unobservedSeconds: 0, bounded: false },
    },
  ])('$name', ({ attribution, buckets, allocated, want }) => {
    const time = accumulateGpuTime(buckets, allocated, attribution);
    expect(time).toEqual(want);
    expect(time.activeSeconds + time.idleSeconds + time.unobservedSeconds).toBe(time.allocatedSeconds);
  });
});

describe('attributeGpus', () => {
  const perNode = (entries: Array<[string, number]>) => new Map(entries);

  it('is exact when every node reports and the GPUs add up to the allocation', () => {
    expect(attributeGpus(['n1', 'n2'], perNode([['n1', 4], ['n2', 4]]), 8)).toEqual({ attribution: 'exact', silentNodes: [] });
  });

  it('is shared when every node reports and the nodes hold more GPUs than the job', () => {
    expect(attributeGpus(['n1', 'n2'], perNode([['n1', 8], ['n2', 8]]), 8)).toEqual({ attribution: 'shared', silentNodes: [] });
  });

  it('is unknown when a node reports nothing, even if the reporting GPUs equal or exceed the allocation', () => {
    const want = { attribution: 'unknown', unknownReason: 'silent-nodes', silentNodes: ['n2'] };
    expect(attributeGpus(['n1', 'n2'], perNode([['n1', 8]]), 8)).toEqual(want);
    expect(attributeGpus(['n1', 'n2'], perNode([['n1', 8]]), 4)).toEqual(want);
    expect(attributeGpus(['n1', 'n2'], perNode([['n1', 8], ['n2', 0]]), 12)).toEqual(want);
  });

  it('is unknown when the nodes report fewer GPUs than the job allocated', () => {
    expect(attributeGpus(['n1', 'n2'], perNode([['n1', 4], ['n2', 3]]), 8)).toEqual({
      attribution: 'unknown',
      unknownReason: 'fewer-gpus-than-allocated',
      silentNodes: [],
    });
  });
});

describe('scoreGpus', () => {
  it('finds the GPUs that never exceeded the idle baseline', () => {
    const result = score([gpu('0', [90, 95, 80, 85]), gpu('1', [70, 0, 0, 60]), gpu('2', [0, 3, 5, 0]), gpu('3', [0, 0, 0, 0])], 4);

    expect(result).toMatchObject({
      allocatedGpus: 4,
      observedGpus: 4,
      attribution: 'exact',
      silentNodes: [],
      activeGpus: 2,
      idleGpus: 2,
      partialGpus: 0,
      neverActiveGpus: 2,
      peakConcurrentActiveGpus: 2,
      completeBuckets: 4,
    });
    // 16 GPU-buckets of 60 s: GPU 0 active 4, GPU 1 active 2.
    expect(result.time).toEqual({ allocatedSeconds: 960, activeSeconds: 360, idleSeconds: 600, unobservedSeconds: 0, bounded: false });
    expect(result.timeInUseShare).toBeCloseTo(0.375);
    // Mean of the six active GPU-buckets: 90, 95, 80, 85, 70, 60.
    expect(result.meanUtilizationWhileActive).toBeCloseTo(80);
    // Idle GPUs first, then active ones, each in GPU order.
    expect(result.gpus.map((item) => [item.gpu, item.activity])).toEqual([
      ['2', 'idle'],
      ['3', 'idle'],
      ['0', 'active'],
      ['1', 'active'],
    ]);
    expect(result.gpus[0]).toMatchObject({ peakUtilization: 5, meanUtilization: 2, observedBuckets: 4, activeBuckets: 0 });
  });

  it('treats the idle baseline as inclusive: only a sample above it is activity', () => {
    expect(score([gpu('0', [5, 5])], 1).idleGpus).toBe(1);
    expect(score([gpu('0', [5, 5.1])], 1).idleGpus).toBe(0);
    expect(score([gpu('0', [0, 0])], 1, { idleBaselinePercent: 0 }).idleGpus).toBe(1);
    expect(score([gpu('0', [0, 1])], 1, { idleBaselinePercent: 0 }).activeGpus).toBe(1);
  });

  it('uses the bucket peak, not the mean, to decide activity', () => {
    const result = score([gpu('0', [40], [2])], 1);
    expect(result.activeGpus).toBe(1);
    expect(result.gpus[0].meanUtilization).toBe(2);
  });

  it('does not match the reporting GPUs to the job when they are fewer than it allocated', () => {
    const result = score([gpu('0', [90, 90]), gpu('1', [0, 0])], 4);

    // GPU 1 is idle, but it may not be the job's: nothing is counted for the job.
    expect(result).toMatchObject({
      attribution: 'unknown',
      unknownReason: 'fewer-gpus-than-allocated',
      observedGpus: 2,
      idleGpus: 1,
      neverActiveGpus: 0,
      peakConcurrentActiveGpus: undefined,
      completeBuckets: 0,
    });
    expect(result.time).toEqual({ allocatedSeconds: 480, activeSeconds: 0, idleSeconds: 0, unobservedSeconds: 480, bounded: false });
    expect(result.timeInUseShare).toBeUndefined();
  });

  it('does not match GPUs to the job when one of its nodes reports nothing, although the count fits', () => {
    // The job holds GPUs 0-3 of n1 and four GPUs of n2, all busy. n2 has no
    // exporter. GPUs 4-7 of n1 are idle and belong to nobody.
    const busy = [95, 95];
    const idle = [0, 0];
    const series = ['0', '1', '2', '3'].map((id) => gpu(id, busy)).concat(['4', '5', '6', '7'].map((id) => gpu(id, idle)));
    const result = score(series, 8, { jobNodes: ['n1', 'n2'] });

    expect(result).toMatchObject({
      attribution: 'unknown',
      unknownReason: 'silent-nodes',
      silentNodes: ['n2'],
      observedGpus: 8,
      neverActiveGpus: 0,
      peakConcurrentActiveGpus: undefined,
    });
    expect(result.time).toMatchObject({ idleSeconds: 0, activeSeconds: 0, unobservedSeconds: 960 });
  });

  it('gives no lower bound either when a node reports nothing and the other reports more GPUs than allocated', () => {
    // The job holds two GPUs on each node. On n1, GPUs 0-1 are busy and 2-7 idle.
    const series = ['0', '1'].map((id) => gpu(id, [95, 95])).concat(['2', '3', '4', '5', '6', '7'].map((id) => gpu(id, [0, 0])));
    const result = score(series, 4, { jobNodes: ['n1', 'n2'] });

    expect(result).toMatchObject({ attribution: 'unknown', unknownReason: 'silent-nodes', silentNodes: ['n2'], neverActiveGpus: 0 });
    expect(result.time.idleSeconds).toBe(0);
  });

  it('ignores series of nodes that are not the job own', () => {
    const result = score([gpu('0', [90, 90]), gpu('1', [90, 90]), gpu('0', [0, 0], [0, 0], 'other'), gpu('1', [0, 0], [0, 0], 'other')], 2, {
      jobNodes: ['n1'],
    });

    expect(result).toMatchObject({ attribution: 'exact', observedGpus: 2, activeGpus: 2, idleGpus: 0 });
    expect(result.gpus.map((item) => item.node)).toEqual(['n1', 'n1']);
  });

  it('calls a GPU idle only when it has telemetry in every bucket', () => {
    const result = score([gpu('0', [90, 90, 90, 90]), gpu('1', [0, NONE, NONE, NONE]), gpu('2', [0, 0, 0, NONE]), gpu('3', [0, 0, 0, 0])], 4);

    expect(result.gpus.map((item) => [item.gpu, item.activity])).toEqual([
      ['3', 'idle'],
      ['1', 'partial'],
      ['2', 'partial'],
      ['0', 'active'],
    ]);
    expect(result).toMatchObject({ attribution: 'exact', idleGpus: 1, partialGpus: 2, neverActiveGpus: 1, completeBuckets: 1 });
    // Idle GPU-buckets: GPU 1 one, GPU 2 three, GPU 3 four. Without telemetry: three and one.
    expect(result.time).toEqual({ allocatedSeconds: 960, activeSeconds: 240, idleSeconds: 480, unobservedSeconds: 240, bounded: false });
    // A GPU may have been active in a bucket in which it did not report.
    expect(result.peakConcurrentActiveGpus).toBeUndefined();
  });

  it('does not call a GPU idle when the start of the job has no telemetry (metrics retention)', () => {
    const result = score([gpu('0', [NONE, NONE, 90, 90]), gpu('1', [NONE, NONE, 0, 0])], 2);

    expect(result.gpus.map((item) => item.activity)).toEqual(['partial', 'active']);
    expect(result).toMatchObject({ attribution: 'exact', neverActiveGpus: 0, completeBuckets: 2 });
    expect(result.time).toEqual({ allocatedSeconds: 480, activeSeconds: 120, idleSeconds: 120, unobservedSeconds: 240, bounded: false });
  });

  it('counts an active GPU as active however little it reported', () => {
    const result = score([gpu('0', [NONE, NONE, NONE, 50]), gpu('1', [0, 0, 0, 0])], 2);
    expect(result.gpus.map((item) => [item.gpu, item.activity])).toEqual([
      ['1', 'idle'],
      ['0', 'active'],
    ]);
  });

  it('gives bounds when the nodes report more GPUs than the job allocated', () => {
    const idle = [0, 0];
    const result = score(
      [gpu('0', [80, 80]), gpu('1', idle), gpu('2', idle), gpu('3', idle), gpu('4', idle), gpu('5', idle), gpu('6', idle), gpu('7', idle)],
      6
    );

    expect(result).toMatchObject({
      attribution: 'shared',
      observedGpus: 8,
      activeGpus: 1,
      idleGpus: 7,
      // At most one of the six allocated GPUs was ever active.
      neverActiveGpus: 5,
      peakConcurrentActiveGpus: 1,
      completeBuckets: 2,
    });
    expect(result.time).toEqual({ allocatedSeconds: 720, activeSeconds: 120, idleSeconds: 600, unobservedSeconds: 0, bounded: true });
  });

  it('proves no idle GPU on shared nodes when enough GPUs were active', () => {
    const result = score(
      [gpu('0', [80]), gpu('1', [80]), gpu('2', [80]), gpu('3', [80]), gpu('4', [60]), gpu('5', [0]), gpu('6', [0]), gpu('7', [0])],
      4
    );

    expect(result).toMatchObject({ attribution: 'shared', activeGpus: 5, neverActiveGpus: 0, peakConcurrentActiveGpus: 4 });
    expect(result.time.idleSeconds).toBe(0);
    expect(result.time.bounded).toBe(true);
  });

  it('does not count GPUs with gaps toward the lower bound on shared nodes', () => {
    const result = score([gpu('0', [80, 80, 80, 80]), gpu('1', [0, NONE, NONE, NONE]), gpu('2', [0, 0, 0, 0])], 2);
    // 2 allocated - 1 active - 1 with gaps: nothing is provably idle.
    expect(result).toMatchObject({ attribution: 'shared', partialGpus: 1, neverActiveGpus: 0 });
  });

  it('counts no idle time on shared nodes while the exporter of one node is down', () => {
    // The job holds GPUs 0-3 of n1 and of n2, all busy. GPUs 4-7 of both
    // nodes are idle and not the job's. The exporter of n2 stops after
    // two of four buckets.
    const node = (name: string, outage: boolean) =>
      ['0', '1', '2', '3', '4', '5', '6', '7'].map((id) => {
        const value = Number(id) < 4 ? 95 : 0;
        return gpu(id, outage ? [value, value, NONE, NONE] : repeat(value, 4), undefined, name);
      });
    const result = score([...node('n1', false), ...node('n2', true)], 8);

    expect(result).toMatchObject({ attribution: 'shared', observedGpus: 16, activeGpus: 8, neverActiveGpus: 0, completeBuckets: 2 });
    // While n2 does not report, the eight GPUs of n1 are no more than the
    // job allocated, but four of them are not the job's.
    expect(result.time).toEqual({ allocatedSeconds: 1920, activeSeconds: 960, idleSeconds: 0, unobservedSeconds: 960, bounded: true });
    expect(result.peakConcurrentActiveGpus).toBeUndefined();
  });

  it('counts no idle time on shared nodes that are never scraped in the same bucket', () => {
    // Scrapes every two buckets, the two nodes in alternating buckets.
    const node = (name: string, phase: number) =>
      ['0', '1', '2', '3', '4', '5', '6', '7'].map((id) =>
        gpu(
          id,
          [0, 1, 2, 3].map((bucket) => (bucket % 2 === phase ? (Number(id) < 4 ? 95 : 0) : NONE)),
          undefined,
          name
        )
      );
    const result = score([...node('n1', 0), ...node('n2', 1)], 8);

    expect(result).toMatchObject({ attribution: 'shared', activeGpus: 8, idleGpus: 0, partialGpus: 8, neverActiveGpus: 0, completeBuckets: 0 });
    expect(result.time).toEqual({ allocatedSeconds: 1920, activeSeconds: 0, idleSeconds: 0, unobservedSeconds: 1920, bounded: true });
    expect(result.timeInUseShare).toBeUndefined();
  });

  it('drops series without a single sample and reports nothing observed', () => {
    const result = score([gpu('0', [NONE, NONE])], 2);

    expect(result).toMatchObject({ observedGpus: 0, attribution: 'unknown', unknownReason: 'silent-nodes', silentNodes: ['n1'] });
    expect(result.timeInUseShare).toBeUndefined();
    expect(result.meanUtilizationWhileActive).toBeUndefined();
    expect(result.time).toEqual({ allocatedSeconds: 240, activeSeconds: 0, idleSeconds: 0, unobservedSeconds: 240, bounded: false });
  });

  it('orders GPUs by node and numeric GPU ID', () => {
    const result = score([gpu('10', [90], [90], 'n2'), gpu('2', [90], [90], 'n2'), gpu('0', [90], [90], 'n10'), gpu('1', [90], [90], 'n2')], 4);
    expect(result.gpus.map((item) => `${item.node}/${item.gpu}`)).toEqual(['n2/1', 'n2/2', 'n2/10', 'n10/0']);
  });
});

describe('scoreMemory', () => {
  const twoActive = () => score([gpu('0', [90]), gpu('1', [90])], 2);
  const mib = (entries: Array<[string, number]>) => new Map(entries.map(([id, value]) => [gpuKey('n1:9400', id), value]));

  it('flags a job whose fullest GPU stayed under the threshold', () => {
    const gpus = twoActive();
    const result = scoreMemory(gpus, mib([['0', 8192], ['1', 4096]]), mib([['0', 73728], ['1', 77824]]), 15);

    expect(result.status).toBe('low');
    expect(result.fullest).toEqual({ instance: 'n1:9400', node: 'n1', gpu: '0', peakMiB: 8192, capacityMiB: 81920, share: 0.1 });
    expect(result.gpusWithCapacity).toBe(2);
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
    const shared = () => score([gpu('0', [90]), gpu('1', [90]), gpu('2', [90])], 2);
    const free = mib([['0', 50], ['1', 50], ['2', 50]]);

    expect(scoreMemory(shared(), mib([['0', 50], ['1', 5], ['2', 5]]), free, 15)).toMatchObject({ status: 'inconclusive', reason: 'shared-gpus' });
    // The job's GPUs cannot be fuller than the fullest GPU of the nodes.
    expect(scoreMemory(shared(), mib([['0', 5], ['1', 5], ['2', 5]]), free, 15).status).toBe('low');
  });

  it('does not report low memory when a GPU has no memory telemetry', () => {
    const result = scoreMemory(twoActive(), mib([['0', 5]]), mib([['0', 95]]), 15);
    expect(result).toMatchObject({ status: 'inconclusive', reason: 'incomplete-data', gpusWithCapacity: 1 });
  });

  it('judges nothing when the reporting GPUs cannot be matched to the job', () => {
    const fewer = score([gpu('0', [90])], 2);
    expect(scoreMemory(fewer, mib([['0', 5]]), mib([['0', 95]]), 15)).toMatchObject({ status: 'inconclusive', reason: 'unattributed-gpus' });
    // Not even a full GPU: it may be another job's.
    expect(scoreMemory(fewer, mib([['0', 90]]), mib([['0', 10]]), 15)).toMatchObject({ status: 'inconclusive', reason: 'unattributed-gpus' });

    const silentNode = score([gpu('0', [90]), gpu('1', [90])], 2, { jobNodes: ['n1', 'n2'] });
    expect(scoreMemory(silentNode, mib([['0', 5], ['1', 5]]), mib([['0', 95], ['1', 95]]), 15)).toMatchObject({
      status: 'inconclusive',
      reason: 'unattributed-gpus',
    });
  });

  it('reports an unknown capacity when only the used metric has data', () => {
    const result = scoreMemory(twoActive(), mib([['0', 65000], ['1', 1000]]), new Map(), 15);
    expect(result).toMatchObject({ status: 'capacity-unknown', highestPeakMiB: 65000, gpusWithCapacity: 0 });
    expect(result.fullest).toBeUndefined();
  });

  it('reports no data when the memory metric returns nothing', () => {
    expect(scoreMemory(twoActive(), new Map(), new Map(), 15).status).toBe('no-data');
  });

  it('does not apply when no GPU was active', () => {
    const idle = score([gpu('0', [0]), gpu('1', [0])], 2);
    expect(scoreMemory(idle, mib([['0', 3], ['1', 3]]), mib([['0', 81917], ['1', 81917]]), 15).status).toBe('not-applicable');
  });

  it('ignores a GPU whose capacity would be zero', () => {
    const result = scoreMemory(twoActive(), mib([['0', 0], ['1', 0]]), mib([['0', 0], ['1', 0]]), 15);
    expect(result.status).toBe('capacity-unknown');
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
    expect(scoreBottleneck(input({ gpuAttribution: 'unknown', idleCpus: repeat(0, BUCKETS) }))).toMatchObject({
      status: 'inconclusive',
      reason: 'unattributed-gpus',
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
