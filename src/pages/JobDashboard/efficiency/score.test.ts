import {
  accumulateGpuTime,
  attributeGpus,
  BottleneckInput,
  coversNearlyAll,
  gpuIdsHaveGaps,
  GpuBucketSeries,
  gpuKey,
  GpuMemoryReading,
  GpuScore,
  scoreBottleneck,
  scoreGpus,
  scoreMemory,
  unreadBottleneck,
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

describe('gpuIdsHaveGaps', () => {
  it.each<[string[], boolean]>([
    [['0', '1', '2', '3'], false],
    [['3', '0', '2', '1'], false],
    // Numbered from 1.
    [['1', '2', '3', '4'], false],
    [['0'], false],
    [['1'], false],
    // The same GPUs reported by two exporter instances.
    [['0', '1', '0', '1'], false],
    // Only GPUs 4-7 of a node report.
    [['4', '5', '6', '7'], true],
    [['2'], true],
    // A GPU in the middle does not report.
    [['0', '1', '3'], true],
    [['1', '2', '4'], true],
    // IDs that are not numbers show nothing.
    [['GPU-4b2c', 'GPU-9e1f'], false],
    [['0', 'a'], false],
    [['00', '01'], false],
    [[], false],
  ])('%j -> %s', (ids, want) => {
    expect(gpuIdsHaveGaps(ids)).toBe(want);
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

  it('does not match GPUs to the job when a node visibly reports only some of its GPUs, although the count fits', () => {
    // The job holds GPUs 0-7 of n1 and GPUs 0-3 of n2, all busy. n2 reports
    // only its GPUs 4-7, which are idle and another job's: 12 GPUs report,
    // and 12 are allocated.
    const ids = ['0', '1', '2', '3', '4', '5', '6', '7'];
    const series = [...ids.map((id) => gpu(id, [95, 95])), ...ids.slice(4).map((id) => gpu(id, [0, 0], undefined, 'n2'))];
    const result = score(series, 12);

    expect(result).toMatchObject({
      attribution: 'unknown',
      unknownReason: 'gpu-id-gaps',
      gapNodes: ['n2'],
      silentNodes: [],
      observedGpus: 12,
      neverActiveGpus: 0,
    });
    expect(result.time).toMatchObject({ idleSeconds: 0, activeSeconds: 0, unobservedSeconds: 12 * 120 });

    // With every GPU of n2 reporting, the same job is exact (and then shared: 16 GPUs for 12).
    const complete = score([...ids.map((id) => gpu(id, [95, 95])), ...ids.map((id) => gpu(id, [95, 95], undefined, 'n2'))], 16);
    expect(complete).toMatchObject({ attribution: 'exact', gapNodes: [] });
  });

  it('names a silent node before a node with gaps in its GPU IDs', () => {
    const result = score([gpu('4', [0, 0]), gpu('5', [0, 0])], 4, { jobNodes: ['n1', 'n2'] });
    expect(result).toMatchObject({ attribution: 'unknown', unknownReason: 'silent-nodes', silentNodes: ['n2'], gapNodes: ['n1'] });
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

  it('calls a GPU idle with telemetry for 95% of the buckets, and records what its telemetry covers', () => {
    const TWENTY = 20;
    const busy = repeat(90, TWENTY);
    // GPU with telemetry in all but `missing` buckets, idle wherever it reports.
    const idleExcept = (id: string, missing: number) => gpu(id, [...repeat(NONE, missing), ...repeat(0, TWENTY - missing)]);

    // 19 of 20 buckets: 95%.
    const oneMissing = score([gpu('0', busy), gpu('1', busy), idleExcept('2', 0), idleExcept('3', 1)], 4);
    expect(oneMissing.gpus.map((item) => [item.gpu, item.activity, item.observedBuckets])).toEqual([
      ['2', 'idle', 20],
      ['3', 'idle', 19],
      ['0', 'active', 20],
      ['1', 'active', 20],
    ]);
    expect(oneMissing).toMatchObject({ idleGpus: 2, partialGpus: 0, neverActiveGpus: 2, bucketCount: 20, idleGpuObservedBuckets: 19 });
    // The time without telemetry stays unobserved: one GPU-bucket of 60 s.
    expect(oneMissing.time).toMatchObject({ idleSeconds: 39 * 60, unobservedSeconds: 60 });
    // A GPU may have been active in the bucket in which it did not report.
    expect(oneMissing.peakConcurrentActiveGpus).toBeUndefined();

    // 18 of 20 buckets: 90%, not enough.
    const twoMissing = score([gpu('0', busy), gpu('1', busy), idleExcept('2', 0), idleExcept('3', 2)], 4);
    expect(twoMissing).toMatchObject({ idleGpus: 1, partialGpus: 1, neverActiveGpus: 1, idleGpuObservedBuckets: 20 });

    // Without an idle GPU the coverage of idle GPUs is that of the window.
    expect(score([gpu('0', busy), gpu('1', busy)], 2)).toMatchObject({ idleGpus: 0, idleGpuObservedBuckets: 20 });
  });

  it('applies the 95% to the buckets of the scored window', () => {
    expect(coversNearlyAll(19, 20)).toBe(true);
    expect(coversNearlyAll(18, 20)).toBe(false);
    expect(coversNearlyAll(114, 120)).toBe(true);
    expect(coversNearlyAll(113, 120)).toBe(false);
    // Fewer than 20 buckets leave no room for a missing one.
    expect(coversNearlyAll(19, 19)).toBe(true);
    expect(coversNearlyAll(18, 19)).toBe(false);
    expect(coversNearlyAll(0, 0)).toBe(false);
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
  /** Memory of GPUs on n1 as [GPU ID, peak use, lowest free memory], covered in the one bucket of the window. */
  const mib = (entries: Array<[string, number | undefined, number | undefined]>, coveredBuckets = 1) =>
    new Map<string, GpuMemoryReading>(
      entries.map(([id, peakUsedMiB, minFreeMiB]) => [gpuKey('n1:9400', id), { peakUsedMiB, minFreeMiB, coveredBuckets }])
    );
  const memory = (gpus: GpuScore, readings: Map<string, GpuMemoryReading>, bucketCount = 1) => scoreMemory(gpus, readings, bucketCount, 15);

  it('flags a job whose fullest GPU stayed under the threshold', () => {
    const gpus = twoActive();
    const result = memory(gpus, mib([['0', 8192, 73728], ['1', 4096, 77824]]));

    expect(result.status).toBe('low');
    expect(result.fullest).toEqual({ instance: 'n1:9400', node: 'n1', gpu: '0', peakMiB: 8192, capacityMiB: 81920, share: 0.1 });
    expect(result).toMatchObject({ gpusWithCapacity: 2, gpusCovered: 2 });
    // The evidence rows carry each GPU's memory.
    expect(gpus.gpus.map((item) => [item.memoryPeakMiB, item.memoryCapacityMiB])).toEqual([
      [8192, 81920],
      [4096, 81920],
    ]);
  });

  it('is ok when the fullest GPU reached the threshold, and the threshold itself is not low', () => {
    expect(memory(twoActive(), mib([['0', 70000, 11920], ['1', 100, 81820]])).status).toBe('ok');
    expect(memory(twoActive(), mib([['0', 15, 85], ['1', 1, 99]])).status).toBe('ok');
  });

  it('cannot tell which GPU is the job own on shared nodes, unless even the fullest is low', () => {
    const shared = () => score([gpu('0', [90]), gpu('1', [90]), gpu('2', [90])], 2);

    expect(memory(shared(), mib([['0', 50, 50], ['1', 5, 50], ['2', 5, 50]]))).toMatchObject({ status: 'inconclusive', reason: 'shared-gpus' });
    // The job's GPUs cannot be fuller than the fullest GPU of the nodes.
    expect(memory(shared(), mib([['0', 5, 50], ['1', 5, 50], ['2', 5, 50]])).status).toBe('low');
  });

  it('does not report low memory when a GPU has no memory telemetry', () => {
    const result = memory(twoActive(), mib([['0', 5, 95]]));
    expect(result).toMatchObject({ status: 'inconclusive', reason: 'incomplete-data', gpusWithCapacity: 1, gpusCovered: 1 });
  });

  it('does not report low memory when the memory telemetry has gaps: the peak may lie in a gap', () => {
    const fourBuckets = () => score([gpu('0', [90, 90, 90, 90]), gpu('1', [90, 90, 90, 90])], 2);
    const low: Array<[string, number, number]> = [['0', 5, 95], ['1', 5, 95]];

    expect(memory(fourBuckets(), mib(low, 4), 4)).toMatchObject({ status: 'low', gpusCovered: 2 });
    expect(memory(fourBuckets(), mib(low, 3), 4)).toMatchObject({ status: 'inconclusive', reason: 'incomplete-data', gpusCovered: 0, gpusWithCapacity: 2 });
    // A GPU that is known to be full settles it whatever the gaps hide.
    expect(memory(fourBuckets(), mib([['0', 90, 10], ['1', 5, 95]], 3), 4).status).toBe('ok');
  });

  it('reports low memory with memory telemetry for 95% of the buckets, and records what it covers', () => {
    const twentyBuckets = () => score([gpu('0', repeat(90, 20)), gpu('1', repeat(90, 20))], 2);
    const low = (covered0: number, covered1: number) =>
      new Map<string, GpuMemoryReading>([
        [gpuKey('n1:9400', '0'), { peakUsedMiB: 5, minFreeMiB: 95, coveredBuckets: covered0 }],
        [gpuKey('n1:9400', '1'), { peakUsedMiB: 5, minFreeMiB: 95, coveredBuckets: covered1 }],
      ]);

    expect(memory(twentyBuckets(), low(20, 20), 20)).toMatchObject({ status: 'low', gpusCovered: 2, coveredBuckets: 20 });
    expect(memory(twentyBuckets(), low(20, 19), 20)).toMatchObject({ status: 'low', gpusCovered: 2, coveredBuckets: 19 });
    expect(memory(twentyBuckets(), low(20, 18), 20)).toMatchObject({ status: 'inconclusive', reason: 'incomplete-data', gpusCovered: 1, coveredBuckets: 20 });
  });

  it('judges nothing when the reporting GPUs cannot be matched to the job', () => {
    const fewer = score([gpu('0', [90])], 2);
    expect(memory(fewer, mib([['0', 5, 95]]))).toMatchObject({ status: 'inconclusive', reason: 'unattributed-gpus' });
    // Not even a full GPU: it may be another job's.
    expect(memory(fewer, mib([['0', 90, 10]]))).toMatchObject({ status: 'inconclusive', reason: 'unattributed-gpus' });

    const silentNode = score([gpu('0', [90]), gpu('1', [90])], 2, { jobNodes: ['n1', 'n2'] });
    expect(memory(silentNode, mib([['0', 5, 95], ['1', 5, 95]]))).toMatchObject({ status: 'inconclusive', reason: 'unattributed-gpus' });
  });

  it('reports an unknown capacity when only the used metric has data', () => {
    const result = memory(twoActive(), mib([['0', 65000, NONE], ['1', 1000, NONE]], 0));
    expect(result).toMatchObject({ status: 'capacity-unknown', highestPeakMiB: 65000, gpusWithCapacity: 0 });
    expect(result.fullest).toBeUndefined();
  });

  it('reports no data when the memory metric returns nothing', () => {
    expect(memory(twoActive(), new Map()).status).toBe('no-data');
    expect(memory(twoActive(), mib([['0', NONE, 500]], 0)).status).toBe('no-data');
  });

  it('does not apply when no GPU was active', () => {
    const idle = score([gpu('0', [0]), gpu('1', [0])], 2);
    expect(memory(idle, mib([['0', 3, 81917], ['1', 3, 81917]])).status).toBe('not-applicable');
  });

  it('ignores a GPU whose capacity would be zero', () => {
    expect(memory(twoActive(), mib([['0', 0, 0], ['1', 0, 0]])).status).toBe('capacity-unknown');
  });
});

describe('scoreBottleneck', () => {
  const WINDOWS = 4;
  type Values = Array<number | undefined>;

  /**
   * One node of 16 CPUs held entirely by the job and two GPUs, read in four
   * windows that cover the scored window. utilization is each GPU's mean
   * per window; idle, ioWait and count are the node's CPUs per window, and
   * samples the samples per CPU series (20: a scrape every 15 s). Every
   * window begins long after the job's start unless windowLeadSeconds says
   * otherwise.
   */
  function input(
    overrides: Partial<BottleneckInput> & { utilization?: Values; idle?: Values; ioWait?: Values; count?: Values; samples?: Values } = {}
  ): BottleneckInput {
    const { utilization = repeat(30, WINDOWS), idle = repeat(8, WINDOWS), ioWait = repeat(0, WINDOWS), count = repeat(16, WINDOWS), ...rest } = overrides;
    const windows = Math.max(count.length, rest.windowCount ?? 0);
    const { samples = repeat(20, windows), ...others } = rest;
    return {
      gpuAttribution: 'exact',
      allocatedGpus: 2,
      gpuMeans: [utilization, utilization],
      jobNodes: ['n1'],
      cpu: [{ node: 'n1', idle, ioWait, count, samples }],
      windowCount: WINDOWS,
      windowSeconds: 300,
      windowLeadSeconds: Array.from({ length: windows }, (_, index) => 3600 + index * 300),
      coverage: 1,
      idleBaselinePercent: 5,
      allocatedCpus: 16,
      ...others,
    };
  }
  const eight = { windowCount: 8, count: repeat(16, 8), ioWait: repeat(0, 8), utilization: repeat(30, 8) };

  it('is ok when underused GPUs meet neither busy CPUs nor I/O wait', () => {
    expect(scoreBottleneck(input())).toEqual({
      status: 'ok',
      cpuAttribution: 'exclusive',
      allocatedCpus: 16,
      nodeCpus: 16,
      silentNodes: [],
      windows: 4,
      coverage: 1,
      scoredWindows: 4,
      unscoredWindows: 0,
      earlyWindows: 0,
      ioScoredWindows: 4,
      lowGpuShare: 1,
      cpuStarvedShare: 0,
      cpuStarvedShareMax: 0,
      ioStarvedShare: 0,
      ioStarvedShareMax: 0,
      meanGpuUtilizationWhileLow: 30,
      meanBusyCpusWhileLow: 8,
      meanIoWaitCpusWhileLow: 0,
    });
  });

  it('is ok when the GPUs are well used, whatever the CPUs do', () => {
    const score = scoreBottleneck(input({ utilization: repeat(90, WINDOWS), idle: repeat(0, WINDOWS) }));
    expect(score).toMatchObject({ status: 'ok', lowGpuShare: 0, cpuStarvedShare: 0 });
    expect(score.meanGpuUtilizationWhileLow).toBeUndefined();
  });

  it('counts GPUs as underused below 50% utilization, not at it', () => {
    const saturated = { idle: repeat(0, WINDOWS) };
    expect(scoreBottleneck(input({ ...saturated, utilization: repeat(50, WINDOWS) }))).toMatchObject({ status: 'ok', lowGpuShare: 0 });
    expect(scoreBottleneck(input({ ...saturated, utilization: repeat(49.9, WINDOWS) }))).toMatchObject({ status: 'cpu-bound', lowGpuShare: 1 });
  });

  it('reports a CPU bottleneck when underused GPUs coincide with saturated CPUs', () => {
    // 16 CPUs, 1.6 idle: 14.4 busy, exactly the 90% that counts as saturated.
    expect(scoreBottleneck(input({ idle: repeat(1.6, WINDOWS) }))).toMatchObject({
      status: 'cpu-bound',
      cpuStarvedShare: 1,
      ioStarvedShare: 0,
      meanBusyCpusWhileLow: 14.4,
    });
    expect(scoreBottleneck(input({ idle: repeat(1.7, WINDOWS) })).status).toBe('ok');
  });

  it('reports an I/O bottleneck when underused GPUs coincide with I/O wait, and does not count waiting as busy', () => {
    // 16 CPUs: 1.6 wait for I/O (10%), 1 is idle. Busy is 13.4, under 90%.
    expect(scoreBottleneck(input({ idle: repeat(1, WINDOWS), ioWait: repeat(1.6, WINDOWS) }))).toMatchObject({
      status: 'io-bound',
      cpuStarvedShare: 0,
      ioStarvedShare: 1,
      meanBusyCpusWhileLow: 13.4,
      meanIoWaitCpusWhileLow: 1.6,
    });
    expect(scoreBottleneck(input({ idle: repeat(1, WINDOWS), ioWait: repeat(1.5, WINDOWS) })).status).toBe('ok');
  });

  it('reports both when each coincides in at least a quarter of the windows', () => {
    const score = scoreBottleneck(input({ idle: [0, 12, 12, 12], ioWait: [0, 0, 0, 4] }));
    expect(score).toMatchObject({ status: 'cpu-and-io-bound', cpuStarvedShare: 0.25, ioStarvedShare: 0.25 });
  });

  it('needs the coincidence in a quarter of the windows with a GPU in use', () => {
    expect(scoreBottleneck(input({ ...eight, idle: [0, ...repeat(8, 7)] }))).toMatchObject({ status: 'ok', cpuStarvedShare: 0.125 });
    expect(scoreBottleneck(input({ ...eight, idle: [0, 0, ...repeat(8, 6)] }))).toMatchObject({ status: 'cpu-bound', cpuStarvedShare: 0.25 });
  });

  it('leaves out the windows in which no GPU was in use', () => {
    // GPUs idle in the first half (a CPU-only phase with saturated CPUs).
    const score = scoreBottleneck(input({ utilization: [0, 0, 90, 90], idle: [0, 0, 8, 8] }));
    expect(score).toMatchObject({ status: 'ok', scoredWindows: 2, unscoredWindows: 0, lowGpuShare: 0 });
    // A mean at the idle baseline is not use.
    expect(scoreBottleneck(input({ utilization: [5, 5, 90, 90], idle: [0, 0, 8, 8] }))).toMatchObject({ status: 'ok', scoredWindows: 2 });
    expect(scoreBottleneck(input({ utilization: [5.1, 5.1, 90, 90], idle: [0, 0, 8, 8] }))).toMatchObject({ status: 'cpu-bound', scoredWindows: 4 });
  });

  it('averages the utilization over the GPUs in use only', () => {
    const score = scoreBottleneck(input({ gpuMeans: [repeat(90, WINDOWS), repeat(0, WINDOWS)], idle: repeat(0, WINDOWS) }));
    // The idle GPU belongs to the idle GPU finding, not to this one.
    expect(score).toMatchObject({ status: 'ok', lowGpuShare: 0 });
  });

  it('adds up the CPUs of the nodes of the job', () => {
    const twoNodes = (idle1: number, idle2: number) =>
      input({
        jobNodes: ['n1', 'n2'],
        allocatedCpus: 32,
        cpu: [
          { node: 'n1', idle: repeat(idle1, WINDOWS), ioWait: repeat(0, WINDOWS), count: repeat(16, WINDOWS), samples: repeat(20, WINDOWS) },
          { node: 'n2', idle: repeat(idle2, WINDOWS), ioWait: repeat(0, WINDOWS), count: repeat(16, WINDOWS), samples: repeat(20, WINDOWS) },
          // A node that is not the job's is ignored.
          { node: 'other', idle: repeat(0, WINDOWS), ioWait: repeat(0, WINDOWS), count: repeat(64, WINDOWS), samples: repeat(20, WINDOWS) },
        ],
      });
    // 16 of 32 CPUs busy.
    expect(scoreBottleneck(twoNodes(0, 16))).toMatchObject({ status: 'ok', nodeCpus: 32, cpuAttribution: 'exclusive', meanBusyCpusWhileLow: 16 });
    expect(scoreBottleneck(twoNodes(1, 1))).toMatchObject({ status: 'cpu-bound', meanBusyCpusWhileLow: 30 });
  });

  it('cannot attribute busy CPUs on nodes the job shares, but idle CPUs clear the job', () => {
    // The job holds 4 of 16 CPUs: 3.6 busy CPUs would saturate it.
    const shared = { allocatedCpus: 4 };
    expect(scoreBottleneck(input({ ...shared, idle: repeat(4, WINDOWS) }))).toMatchObject({
      status: 'inconclusive',
      reason: 'shared-cpus',
      cpuAttribution: 'shared',
      cpuStarvedShare: 1,
    });
    expect(scoreBottleneck(input({ ...shared, idle: repeat(13, WINDOWS) }))).toMatchObject({
      status: 'ok',
      cpuAttribution: 'shared',
      cpuStarvedShare: 0,
    });
  });

  it('is inconclusive without a CPU allocation, or with one larger than the CPUs that report', () => {
    expect(scoreBottleneck(input({ allocatedCpus: 0, idle: repeat(0, WINDOWS) }))).toMatchObject({
      status: 'inconclusive',
      reason: 'cpu-allocation-unknown',
      cpuAttribution: 'unknown',
    });
    expect(scoreBottleneck(input({ allocatedCpus: 32, idle: repeat(0, WINDOWS) }))).toMatchObject({
      status: 'inconclusive',
      reason: 'cpu-allocation-exceeds-nodes',
      cpuAttribution: 'unknown',
      nodeCpus: 16,
    });
  });

  it('is inconclusive when the GPUs cannot be attributed to the job', () => {
    expect(scoreBottleneck(input({ gpuAttribution: 'shared', idle: repeat(0, WINDOWS) }))).toMatchObject({
      status: 'inconclusive',
      reason: 'shared-gpus',
      scoredWindows: 0,
    });
    expect(scoreBottleneck(input({ gpuAttribution: 'unknown', idle: repeat(0, WINDOWS) }))).toMatchObject({
      status: 'inconclusive',
      reason: 'unattributed-gpus',
      scoredWindows: 0,
    });
  });

  it('reports no data without CPU telemetry', () => {
    expect(scoreBottleneck(input({ cpu: [] }))).toMatchObject({ status: 'no-data', nodeCpus: undefined });
  });

  it('does not judge the CPUs of a job when one of its nodes has no CPU telemetry', () => {
    // n1 reports 16 CPUs, as many as the job allocated, but the job also runs on n2.
    const silentNode = { jobNodes: ['n1', 'n2'] };
    for (const idle of [0, 16]) {
      expect(scoreBottleneck(input({ ...silentNode, idle: repeat(idle, WINDOWS) }))).toMatchObject({
        status: 'inconclusive',
        reason: 'silent-cpu-nodes',
        silentNodes: ['n2'],
        cpuAttribution: 'unknown',
        scoredWindows: 0,
      });
    }
  });

  it('does not rule out an I/O bottleneck without I/O wait telemetry', () => {
    const none = repeat(NONE, WINDOWS);
    expect(scoreBottleneck(input({ ioWait: none }))).toMatchObject({
      status: 'inconclusive',
      reason: 'no-io-wait-data',
      ioScoredWindows: 0,
      ioStarvedShareMax: 1,
    });
    // A CPU bottleneck is still reported.
    expect(scoreBottleneck(input({ ioWait: none, idle: repeat(0, WINDOWS) })).status).toBe('cpu-bound');
  });

  it('treats a window without CPU telemetry as unknown: it neither shows nor rules out a bottleneck', () => {
    const gap = { count: [NONE, NONE, 16, 16] };
    // Two of four windows are starved for sure: enough on their own.
    expect(scoreBottleneck(input({ ...gap, idle: [NONE, NONE, 0, 0] }))).toMatchObject({
      status: 'cpu-bound',
      scoredWindows: 2,
      unscoredWindows: 2,
      cpuStarvedShare: 0.5,
      cpuStarvedShareMax: 1,
    });
    // No starved window is known, but the two unknown ones could be.
    expect(scoreBottleneck(input({ ...gap, idle: [NONE, NONE, 8, 8] }))).toMatchObject({
      status: 'inconclusive',
      reason: 'incomplete-telemetry',
      cpuStarvedShare: 0,
      cpuStarvedShareMax: 0.5,
      ioStarvedShareMax: 0.5,
    });
    // One unknown window of eight cannot reach a quarter.
    expect(scoreBottleneck(input({ ...eight, idle: [NONE, ...repeat(8, 7)], count: [NONE, ...repeat(16, 7)] }))).toMatchObject({
      status: 'ok',
      unscoredWindows: 1,
      cpuStarvedShareMax: 0.125,
    });
    // One starved window of eight is not a bottleneck, but with one unknown window it might be.
    expect(scoreBottleneck(input({ ...eight, idle: [NONE, 0, ...repeat(8, 6)], count: [NONE, ...repeat(16, 7)] }))).toMatchObject({
      status: 'inconclusive',
      reason: 'incomplete-telemetry',
      cpuStarvedShare: 0.125,
      cpuStarvedShareMax: 0.25,
    });
  });

  it('does not score a window in which a node reports only some of its CPUs', () => {
    // In the second window eight CPUs report, all of them busy.
    const score = scoreBottleneck(input({ ...eight, count: [16, 8, ...repeat(16, 6)], idle: [8, 0, ...repeat(8, 6)] }));
    expect(score).toMatchObject({ status: 'ok', nodeCpus: 16, scoredWindows: 7, unscoredWindows: 1, cpuStarvedShare: 0 });
  });

  it('does not score a window whose CPU rate could reach back before the start of the job', () => {
    // The CPUs are saturated in every window. The windows begin 75, 375, 675
    // and 975 seconds after the job's start.
    const saturated = { idle: repeat(0, WINDOWS), windowLeadSeconds: [75, 375, 675, 975] };
    const scoredWith = (samples: Values) => scoreBottleneck(input({ ...saturated, samples }));

    // Five samples in five minutes: scraped less than 75 s apart. The sample
    // before the first window is then inside the job.
    expect(scoredWith(repeat(5, WINDOWS))).toMatchObject({ status: 'cpu-bound', scoredWindows: 4, unscoredWindows: 0, earlyWindows: 0 });
    // Four samples: up to 100 s apart. A store that also reads the sample
    // before the window may read 25 s of the job before in the first window.
    expect(scoredWith(repeat(4, WINDOWS))).toMatchObject({ status: 'cpu-bound', scoredWindows: 3, unscoredWindows: 1, earlyWindows: 1 });
    expect(scoredWith(repeat(4, WINDOWS)).cpuStarvedShare).toBe(0.75);
    // Two samples: up to 300 s apart. Only windows that begin 300 s into the job are safe.
    expect(scoredWith(repeat(2, WINDOWS))).toMatchObject({ scoredWindows: 3, earlyWindows: 1 });
    expect(scoreBottleneck(input({ ...saturated, windowLeadSeconds: [75, 299, 300, 975], samples: repeat(2, WINDOWS) }))).toMatchObject({
      scoredWindows: 2,
      unscoredWindows: 2,
      earlyWindows: 2,
    });
    // The window that decides is the one with the fewest samples.
    expect(scoredWith([4, 20, 20, 20])).toMatchObject({ scoredWindows: 3, earlyWindows: 1 });
    expect(scoredWith([20, 2, 2, 2])).toMatchObject({ scoredWindows: 4, earlyWindows: 0 });
  });

  it('proves nothing from the windows that are left when the early ones could hold the bottleneck', () => {
    // One of two windows is too early: the other one shows no bottleneck, but half of the windows are unknown.
    const score = scoreBottleneck(input({ windowCount: 2, count: [16, 16], idle: [8, 8], ioWait: [0, 0], utilization: [30, 30], windowLeadSeconds: [75, 375], samples: [3, 3] }));
    expect(score).toMatchObject({ status: 'inconclusive', reason: 'incomplete-telemetry', scoredWindows: 1, earlyWindows: 1, cpuStarvedShareMax: 0.5 });
  });

  it('does not score a window in which a GPU of the job has no telemetry', () => {
    const score = scoreBottleneck(input({ ...eight, idle: repeat(0, 8), gpuMeans: [repeat(90, 8), [NONE, ...repeat(90, 7)]] }));
    // In the first window the one GPU that reports is well used; the other may not have been.
    expect(score).toMatchObject({ status: 'ok', scoredWindows: 7, unscoredWindows: 1 });
    // More GPUs than the job allocated cannot be the job's either.
    expect(scoreBottleneck(input({ allocatedGpus: 1 }))).toMatchObject({ status: 'inconclusive', reason: 'incomplete-telemetry', scoredWindows: 0 });
  });

  it('does not apply when no GPU was in use in any window', () => {
    expect(scoreBottleneck(input({ utilization: repeat(0, WINDOWS) }))).toMatchObject({ status: 'not-applicable', reason: 'no-active-gpu' });
  });

  it('takes the CPU count of a node from the window in which the most CPUs reported', () => {
    const score = scoreBottleneck(input({ count: [16, 32, 32, 16], idle: [8, 16, 16, 8], allocatedCpus: 32 }));
    expect(score).toMatchObject({ nodeCpus: 32, cpuAttribution: 'exclusive', scoredWindows: 2, unscoredWindows: 2 });
  });

  it('refuses CPU telemetry that is not a per-CPU counter', () => {
    // One series per node whose idle rate is 64 CPU-seconds per second.
    expect(scoreBottleneck(input({ count: repeat(1, WINDOWS), idle: repeat(64, WINDOWS), allocatedCpus: 1 }))).toMatchObject({
      status: 'inconclusive',
      reason: 'cpu-telemetry-out-of-range',
    });
  });

  it('needs enough windows, or windows that cover half of the scored window', () => {
    const starved = { idle: repeat(0, 12), count: repeat(16, 12), ioWait: repeat(0, 12), utilization: repeat(30, 12) };
    // Three readings of five minutes in a long job decide nothing.
    expect(scoreBottleneck(input({ idle: repeat(0, 3), windowCount: 3, coverage: 0.01 }))).toMatchObject({
      status: 'inconclusive',
      reason: 'too-few-windows',
      cpuStarvedShare: 1,
    });
    expect(scoreBottleneck(input({ idle: repeat(8, 3), windowCount: 3, coverage: 0.49 }))).toMatchObject({ status: 'inconclusive', reason: 'too-few-windows' });
    // A short job that the windows cover.
    expect(scoreBottleneck(input({ idle: repeat(0, 3), windowCount: 3, coverage: 0.5 })).status).toBe('cpu-bound');
    expect(scoreBottleneck(input({ ...starved, windowCount: 11, coverage: 0.01 })).status).toBe('inconclusive');
    expect(scoreBottleneck(input({ ...starved, windowCount: 12, coverage: 0.01 })).status).toBe('cpu-bound');
  });

  it('is inconclusive when no window fits into the scored window', () => {
    expect(scoreBottleneck(input({ windowCount: 0, coverage: 0, cpu: [] }))).toMatchObject({ status: 'inconclusive', reason: 'no-window' });
  });

  it('describes a job whose CPU windows were not read', () => {
    expect(unreadBottleneck(input(), { status: 'failed', error: 'boom' })).toMatchObject({
      status: 'failed',
      error: 'boom',
      windows: 4,
      scoredWindows: 0,
      silentNodes: [],
      nodeCpus: undefined,
    });
  });
});
