import { DEFAULT_PHASE_THRESHOLDS, quantile, segmentPhases } from './segment';
import { PhaseId, PhaseInput, PhaseSignals, PhaseThresholds, SignalMatrix } from './types';

const STEP = 60;
const START = 1_750_000_020;
const MIB = 1024 * 1024;

/** GPU state of one node in one bucket, written as a letter. */
const GPU_STATES: Record<string, { power: number; util: number; max: number }> = {
  W: { power: 300, util: 95, max: 100 }, // working
  i: { power: 60, util: 0, max: 0 }, // every GPU idle
  l: { power: 100, util: 20, max: 40 }, // below the working level, not idle
  '.': { power: NaN, util: NaN, max: NaN }, // no telemetry
};

function gpuSignals(nodes: string[]): PhaseSignals {
  const pick = (key: 'power' | 'util' | 'max'): SignalMatrix =>
    nodes.map((row) => Float64Array.from([...row].map((letter) => GPU_STATES[letter][key])));
  return { gpuPower: pick('power'), gpuUtilMean: pick('util'), gpuUtilMax: pick('max') };
}

/** One job-level series, written as one value per bucket, put on node 0. */
function onFirstNode(values: number[], nodeCount: number): SignalMatrix {
  return Array.from({ length: nodeCount }, (_, node) => (node === 0 ? Float64Array.from(values) : new Float64Array(values.length).fill(NaN)));
}

function everyNode(values: number[], nodeCount: number): SignalMatrix {
  return Array.from({ length: nodeCount }, () => Float64Array.from(values));
}

/** CPU load that follows the GPU state: busy while working, idle (under the noise floor) otherwise. */
const CPU_OF_STATE: Record<string, number> = { W: 0.2, i: 0.004, l: 0.1, '.': 0.004 };

function cpuFollowingGpu(nodes: string[]): SignalMatrix {
  return nodes.map((row) => Float64Array.from([...row].map((letter) => CPU_OF_STATE[letter])));
}

/**
 * A job from its GPU states. The CPU load follows the GPU state unless
 * `extra` sets it; `{ cpuBusy: undefined }` gives a job without CPU telemetry.
 */
function buildInput(nodes: string[], extra: PhaseSignals = {}, stepSec = STEP): PhaseInput {
  return {
    startSec: START,
    stepSec,
    bucketCount: nodes[0].length,
    nodeCount: nodes.length,
    signals: { ...gpuSignals(nodes), cpuBusy: cpuFollowingGpu(nodes), ...extra },
  };
}

/** Labels as letters: I init, C compute, K checkpoint, S stalled, u unclassified, n no data. */
const LETTERS: Record<PhaseId, string> = { init: 'I', compute: 'C', checkpoint: 'K', stalled: 'S', unclassified: 'u', 'no-data': 'n' };

function letters(labels: PhaseId[]): string {
  return labels.map((label) => LETTERS[label]).join('');
}

function repeat(letter: string, count: number): string {
  return letter.repeat(count);
}

describe('quantile', () => {
  it('interpolates between order statistics and ignores non-finite values', () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([4, NaN, 1, 2, 3], 0.9)).toBeCloseTo(3.7);
    expect(quantile([7], 0.9)).toBe(7);
    expect(quantile([NaN, Infinity], 0.5)).toBeNull();
    expect(quantile([], 0.5)).toBeNull();
  });
});

describe('segmentPhases: the four phases', () => {
  // 5 min startup, 20 min compute, a 2 min checkpoint, 10 min compute, 15 min stall.
  const gpu = repeat('i', 5) + repeat('W', 20) + repeat('i', 2) + repeat('W', 10) + repeat('i', 15);
  const write = [...Array(5).fill(2 * MIB), ...Array(20).fill(50e3), 150 * MIB, 90 * MIB, ...Array(10).fill(50e3), ...Array(15).fill(0)];
  const cpu = [...Array(5).fill(0.4), ...Array(20).fill(0.2), 0.1, 0.1, ...Array(10).fill(0.2), ...Array(15).fill(0.004)];
  const network = [...Array(5).fill(1e5), ...Array(20).fill(5e8), 1e5, 1e5, ...Array(10).fill(5e8), ...Array(15).fill(2e4)];
  const result = segmentPhases(
    buildInput([gpu, gpu], {
      storageWrite: onFirstNode(write, 2),
      cpuBusy: everyNode(cpu, 2),
      network: everyNode(network, 2),
    })
  );

  it('labels startup, compute, checkpoint and stall', () => {
    expect(letters(result.labels)).toBe(repeat('I', 5) + repeat('C', 20) + repeat('K', 2) + repeat('C', 10) + repeat('S', 15));
    expect(result.reasons.every((reason) => reason === undefined)).toBe(true);
  });

  it('returns segments that tile the window', () => {
    expect(result.segments).toEqual([
      { phase: 'init', fromSec: START, toSec: START + 300 },
      { phase: 'compute', fromSec: START + 300, toSec: START + 1500 },
      { phase: 'checkpoint', fromSec: START + 1500, toSec: START + 1620 },
      { phase: 'compute', fromSec: START + 1620, toSec: START + 2220 },
      { phase: 'stalled', fromSec: START + 2220, toSec: START + 3120 },
    ]);
  });

  it('returns totals whose shares add up to 1', () => {
    expect(result.totals.map((total) => [total.phase, total.seconds, total.segmentCount])).toEqual([
      ['init', 300, 1],
      ['compute', 1800, 2],
      ['checkpoint', 120, 1],
      ['stalled', 900, 1],
    ]);
    expect(result.totals.reduce((sum, total) => sum + total.share, 0)).toBeCloseTo(1, 12);
  });

  it('reports the working level, the baselines and the evidence of each phase', () => {
    expect(result.gpuBasis).toBe('power+utilization');
    expect(result.workingLevel).toEqual({ gpuPowerWatts: 300, gpuUtilPercent: 95 });
    expect(result.baselines.storageWriteBytesPerSecond).toBe(50e3);
    expect(result.baselines.cpuBusy).toBeCloseTo(0.2);
    expect(result.baselines.writeBurstBytesPerSecond).toBe(MIB);
    const compute = result.totals.find((total) => total.phase === 'compute');
    expect(compute?.evidence).toEqual({
      gpuPowerWatts: 300,
      gpuUtilPercent: 95,
      cpuBusy: expect.closeTo(0.2),
      storageWriteBytesPerSecond: 50e3,
      networkBytesPerSecond: 1e9,
    });
    const checkpoint = result.totals.find((total) => total.phase === 'checkpoint');
    expect(checkpoint?.evidence.storageWriteBytesPerSecond).toBe(120 * MIB);
    expect(checkpoint?.evidence.gpuPowerWatts).toBe(60);
  });

  it('reports full coverage and no findings', () => {
    expect(result.coverage.gpuPower).toBe(1);
    expect(result.coverage.storageWrite).toBe(0.5);
    expect(result.nodeFindings).toEqual([]);
    expect(result.silentNodes).toEqual([]);
  });
});

describe('segmentPhases: stall against idle between steps', () => {
  const zeroWrite = (count: number) => ({ storageWrite: onFirstNode(Array(count).fill(0), 1) });

  it('leaves an idle stretch shorter than the stall time unclassified', () => {
    const gpu = repeat('W', 10) + repeat('i', 9) + repeat('W', 10);
    const result = segmentPhases(buildInput([gpu], zeroWrite(gpu.length)));
    expect(letters(result.labels)).toBe(repeat('C', 10) + repeat('u', 9) + repeat('C', 10));
    expect(result.unclassifiedReasons).toEqual([{ reason: 'gpu-idle-short', seconds: 540, segmentCount: 1 }]);
  });

  it('calls an idle stretch of exactly the stall time a stall', () => {
    const gpu = repeat('W', 10) + repeat('i', 10) + repeat('W', 10);
    const result = segmentPhases(buildInput([gpu], zeroWrite(gpu.length)));
    expect(letters(result.labels)).toBe(repeat('C', 10) + repeat('S', 10) + repeat('C', 10));
  });

  it('uses the configured stall time', () => {
    const gpu = repeat('W', 10) + repeat('i', 3) + repeat('W', 10);
    const thresholds: PhaseThresholds = { ...DEFAULT_PHASE_THRESHOLDS, stallMinSeconds: 180 };
    expect(letters(segmentPhases(buildInput([gpu]), thresholds).labels)).toBe(repeat('C', 10) + repeat('S', 3) + repeat('C', 10));
  });

  it('calls one long bucket a stall when the bucket is longer than the stall time', () => {
    const result = segmentPhases(buildInput(['WWiWW'], {}, 1200));
    expect(letters(result.labels)).toBe('CCSCC');
  });

  it('does not count a stretch with GPU activity below the working level as a stall', () => {
    const gpu = repeat('W', 10) + repeat('l', 30);
    const result = segmentPhases(buildInput([gpu], zeroWrite(gpu.length)));
    expect(letters(result.labels)).toBe(repeat('C', 10) + repeat('u', 30));
    expect(result.unclassifiedReasons[0].reason).toBe('gpu-low');
  });

  it('ends a stall where one GPU sample exceeds the idle threshold', () => {
    const input = buildInput([repeat('W', 5) + repeat('i', 25)]);
    input.signals.gpuUtilMax![0][17] = 5.1;
    const result = segmentPhases(input);
    expect(letters(result.labels)).toBe(repeat('C', 5) + repeat('S', 12) + 'u' + repeat('S', 12));
  });

  it('treats a sample at the idle threshold as idle', () => {
    const input = buildInput([repeat('W', 5) + repeat('i', 12)]);
    input.signals.gpuUtilMax![0].fill(5, 5);
    expect(letters(segmentPhases(input).labels)).toBe(repeat('C', 5) + repeat('S', 12));
  });

  it('does not call a stretch before the first compute bucket a stall', () => {
    const result = segmentPhases(buildInput([repeat('i', 40) + repeat('W', 5)]));
    expect(letters(result.labels)).toBe(repeat('I', 40) + repeat('C', 5));
  });
});

describe('segmentPhases: the working level is the 90th percentile of the active node buckets', () => {
  /** One node, 20 active buckets at full utilization: the first `bursts` of them at 300 W, the others at 100 W. */
  const withBursts = (bursts: number) => {
    const gpu = repeat('W', 20);
    const power = [Float64Array.from([...Array(bursts).fill(300), ...Array(20 - bursts).fill(100)])];
    return segmentPhases(buildInput([gpu], { gpuPower: power }));
  };

  it('follows the bursts when they fill more than a tenth of the active buckets, and calls the steady work "GPUs low"', () => {
    // 4 of 20: the 90th percentile is 300 W, and 100 W is under half of it. (At the 80th percentile it would be 140 W.)
    const result = withBursts(4);
    expect(result.workingLevel.gpuPowerWatts).toBe(300);
    expect(letters(result.labels)).toBe(repeat('C', 4) + repeat('u', 16));
    expect(result.unclassifiedReasons[0].reason).toBe('gpu-low-write-unknown');
  });

  it('stays near the steady work when the bursts fill a tenth of the active buckets', () => {
    // 2 of 20: the 90th percentile is 120 W, so 100 W works. (At the 95th percentile it would be 300 W.)
    const result = withBursts(2);
    expect(result.workingLevel.gpuPowerWatts).toBeCloseTo(120, 9);
    expect(letters(result.labels)).toBe(repeat('C', 20));
  });
});

describe('segmentPhases: limits that the documents state', () => {
  it('leaves a job unclassified when most of its nodes have weaker GPUs, although every GPU is busy', () => {
    // Three nodes at 150 W and two at 400 W, all at 95 % utilization: the level in power comes from the stronger model.
    const gpu = repeat('W', 20);
    const power = [150, 150, 150, 400, 400].map((watts) => new Float64Array(20).fill(watts));
    const result = segmentPhases(buildInput([gpu, gpu, gpu, gpu, gpu], { gpuPower: power }));
    expect(result.workingLevel.gpuPowerWatts).toBe(400);
    expect(letters(result.labels)).toBe(repeat('u', 20));
    expect(result.unclassifiedReasons).toEqual([{ reason: 'no-compute', seconds: 1200, segmentCount: 1 }]);
  });

  it('reads a hang that keeps GPU utilization above the idle threshold as compute when it fills most of the active time', () => {
    // 3 minutes of compute, then 3 hours at 12 % utilization and low power: the hang's level becomes the working level.
    const buckets = 3 + 180;
    const row = (work: number, hang: number) => [Float64Array.from([...Array(3).fill(work), ...Array(180).fill(hang)])];
    const result = segmentPhases({
      startSec: START,
      stepSec: STEP,
      bucketCount: buckets,
      nodeCount: 1,
      signals: { gpuPower: row(300, 80), gpuUtilMean: row(95, 12), gpuUtilMax: row(100, 14), cpuBusy: row(0.2, 0.004) },
    });
    expect(result.workingLevel.gpuUtilPercent).toBe(12);
    expect(letters(result.labels)).toBe(repeat('C', buckets));
  });
});

describe('segmentPhases: a job without a working level', () => {
  it('does not call a job whose GPUs were idle throughout stalled', () => {
    const result = segmentPhases(buildInput([repeat('i', 60), repeat('i', 60)]));
    expect(letters(result.labels)).toBe(repeat('u', 60));
    expect(result.unclassifiedReasons).toEqual([{ reason: 'no-compute', seconds: 3600, segmentCount: 1 }]);
    expect(result.workingLevel).toEqual({ gpuPowerWatts: null, gpuUtilPercent: null });
  });

  it('needs a utilization of twice the idle threshold for a working level', () => {
    const input = buildInput([repeat('W', 30)]);
    input.signals.gpuUtilMean![0].fill(9.9);
    input.signals.gpuUtilMax![0].fill(30);
    expect(segmentPhases(input).unclassifiedReasons[0].reason).toBe('no-compute');
    input.signals.gpuUtilMean![0].fill(10);
    expect(letters(segmentPhases(input).labels)).toBe(repeat('C', 30));
  });

  it('finds the working level of a job that hangs after a short compute stretch', () => {
    const result = segmentPhases(buildInput([repeat('W', 2) + repeat('i', 98)]));
    expect(letters(result.labels)).toBe(repeat('C', 2) + repeat('S', 98));
    expect(result.workingLevel.gpuPowerWatts).toBe(300);
  });

  it('labels a job that computes throughout as compute', () => {
    expect(letters(segmentPhases(buildInput([repeat('W', 12)])).labels)).toBe(repeat('C', 12));
  });
});

describe('segmentPhases: thresholds relative to the job', () => {
  const gpu = repeat('i', 3) + repeat('W', 10) + repeat('i', 2) + repeat('W', 10) + repeat('i', 12);
  const write = onFirstNode([...Array(13).fill(50e3), 100 * MIB, 100 * MIB, ...Array(22).fill(50e3)], 1);
  const expected = repeat('I', 3) + repeat('C', 10) + repeat('K', 2) + repeat('C', 10) + repeat('S', 12);

  it.each([0.01, 0.3, 1, 2.5, 1000])('gives the same result when every power value is multiplied by %s', (factor) => {
    const input = buildInput([gpu], { storageWrite: write });
    input.signals.gpuPower = input.signals.gpuPower!.map((row) => row.map((value) => value * factor));
    expect(letters(segmentPhases(input).labels)).toBe(expected);
  });

  it('segments a power-capped job whose working power is under twice its idle power', () => {
    const input = buildInput([gpu], { storageWrite: write });
    input.signals.gpuPower = input.signals.gpuPower!.map((row) => row.map((value) => (value === 300 ? 100 : value)));
    const result = segmentPhases(input);
    expect(letters(result.labels)).toBe(expected);
    expect(result.workingLevel.gpuPowerWatts).toBe(100);
  });

  it('sees a half-idle bucket of a power-capped job through utilization', () => {
    // Power 76 W is above half of the 100 W working level; utilization 38% is under half of 95%.
    const input = buildInput([repeat('W', 10) + 'l' + repeat('W', 10)], { storageWrite: onFirstNode(Array(21).fill(0), 1) });
    input.signals.gpuPower![0].fill(100);
    input.signals.gpuPower![0][10] = 76;
    input.signals.gpuUtilMean![0][10] = 38;
    input.signals.gpuUtilMax![0][10] = 100;
    expect(letters(segmentPhases(input).labels)).toBe(repeat('C', 10) + 'u' + repeat('C', 10));
  });

  it('sees a busy-waiting GPU through power: full utilization at idle power is not compute', () => {
    const input = buildInput([repeat('W', 20) + repeat('W', 20)]);
    input.signals.gpuPower![0].fill(80, 20);
    const result = segmentPhases(input);
    expect(letters(result.labels)).toBe(repeat('C', 20) + repeat('u', 20));
    expect(result.unclassifiedReasons[0].reason).toBe('gpu-low-write-unknown');
  });
});

describe('segmentPhases: checkpoints', () => {
  const gpu = repeat('W', 10) + 'ii' + repeat('W', 10);
  const writes = (burst: number, base = 50e3) => onFirstNode([...Array(10).fill(base), burst, burst, ...Array(10).fill(base)], 1);

  it('needs the smallest write rate', () => {
    expect(letters(segmentPhases(buildInput([gpu], { storageWrite: writes(MIB - 1) })).labels)).toBe(repeat('C', 10) + 'uu' + repeat('C', 10));
    expect(letters(segmentPhases(buildInput([gpu], { storageWrite: writes(MIB) })).labels)).toBe(repeat('C', 10) + 'KK' + repeat('C', 10));
  });

  it('needs three times the write rate of the compute buckets', () => {
    const base = 40 * MIB;
    const below = segmentPhases(buildInput([gpu], { storageWrite: writes(3 * base - 1, base) }));
    expect(letters(below.labels)).toBe(repeat('C', 10) + 'uu' + repeat('C', 10));
    expect(below.unclassifiedReasons[0].reason).toBe('gpu-idle-short');
    const above = segmentPhases(buildInput([gpu], { storageWrite: writes(3 * base, base) }));
    expect(letters(above.labels)).toBe(repeat('C', 10) + 'KK' + repeat('C', 10));
    expect(above.baselines.writeBurstBytesPerSecond).toBe(3 * base);
  });

  it('uses the configured smallest write rate', () => {
    const thresholds: PhaseThresholds = { ...DEFAULT_PHASE_THRESHOLDS, checkpointMinWriteBytesPerSecond: 200e3 };
    const result = segmentPhases(buildInput([gpu], { storageWrite: writes(300e3) }), thresholds);
    expect(letters(result.labels)).toBe(repeat('C', 10) + 'KK' + repeat('C', 10));
  });

  it('adds the write rates of the nodes', () => {
    const half = everyNode([...Array(10).fill(0), MIB / 2, MIB / 2, ...Array(10).fill(0)], 2);
    expect(letters(segmentPhases(buildInput([gpu, gpu], { storageWrite: half })).labels)).toBe(repeat('C', 10) + 'KK' + repeat('C', 10));
  });

  it('does not report a write burst while the GPUs work as a checkpoint', () => {
    const write = onFirstNode([...Array(5).fill(0), 500 * MIB, ...Array(16).fill(0)], 1);
    expect(letters(segmentPhases(buildInput([repeat('W', 22)], { storageWrite: write })).labels)).toBe(repeat('C', 22));
  });

  it('leaves a GPU dip unclassified when the cluster has no storage write series', () => {
    const result = segmentPhases(buildInput([gpu]));
    expect(letters(result.labels)).toBe(repeat('C', 10) + 'uu' + repeat('C', 10));
    expect(result.unclassifiedReasons).toEqual([{ reason: 'gpu-low-write-unknown', seconds: 120, segmentCount: 1 }]);
    expect(result.coverage.storageWrite).toBe(0);
  });

  it('leaves a GPU dip unclassified in a bucket without a write sample', () => {
    const write = writes(100 * MIB);
    write[0][10] = NaN;
    const result = segmentPhases(buildInput([gpu], { storageWrite: write }));
    expect(letters(result.labels)).toBe(repeat('C', 10) + 'uK' + repeat('C', 10));
    expect(result.reasons[10]).toBe('gpu-low-write-unknown');
  });

  it('keeps a write burst before the first compute bucket in the startup', () => {
    const write = onFirstNode([300 * MIB, 300 * MIB, ...Array(10).fill(0)], 1);
    expect(letters(segmentPhases(buildInput(['ii' + repeat('W', 10)], { storageWrite: write })).labels)).toBe('II' + repeat('C', 10));
  });

  it('gives a dip that is below the working level but not idle its own reason', () => {
    const low = repeat('W', 10) + 'll' + repeat('W', 10);
    const result = segmentPhases(buildInput([low], { storageWrite: writes(0) }));
    expect(letters(result.labels)).toBe(repeat('C', 10) + 'uu' + repeat('C', 10));
    expect(result.unclassifiedReasons).toEqual([{ reason: 'gpu-low', seconds: 120, segmentCount: 1 }]);
  });
});

describe('segmentPhases: writes inside an idle run', () => {
  const hang = (computeBuckets: number, idleBuckets: number, writeAt: number[], rate = 80 * MIB) => {
    const write = new Array(computeBuckets + idleBuckets).fill(0);
    writeAt.forEach((bucket) => (write[computeBuckets + bucket] = rate));
    return segmentPhases(buildInput([repeat('W', computeBuckets) + repeat('i', idleBuckets)], { storageWrite: onFirstNode(write, 1) }));
  };

  it('reports a stall with one write burst in its middle as one stall', () => {
    expect(letters(hang(5, 25, [12]).labels)).toBe(repeat('C', 5) + repeat('S', 25));
  });

  it('finds a stall of the stall time when a written bucket leaves less than the stall time on each side', () => {
    // 19 idle minutes with a write in the tenth: 9 minutes on each side, a stall all the same.
    const result = hang(5, 19, [9]);
    expect(letters(result.labels)).toBe(repeat('C', 5) + repeat('S', 19));
    expect(result.segments.map((segment) => segment.phase)).toEqual(['compute', 'stalled']);
  });

  it('reports a hang in which a node writes for a minute every nine minutes as one stall', () => {
    const result = hang(30, 60, [8, 17, 26, 35, 44, 53], 4 * MIB);
    expect(letters(result.labels)).toBe(repeat('C', 30) + repeat('S', 60));
  });

  it('calls an idle run shorter than the stall time a checkpoint only in the buckets that write', () => {
    const result = hang(5, 9, [3, 4]);
    expect(letters(result.labels)).toBe(repeat('C', 5) + 'uuuKKuuuu');
    expect(result.unclassifiedReasons).toEqual([{ reason: 'gpu-idle-short', seconds: 420, segmentCount: 2 }]);
  });

  it('calls a long idle run a checkpoint when it writes at burst level in more than half of its buckets', () => {
    expect(letters(hang(5, 12, [0, 1, 2, 3, 4, 5, 6]).labels)).toBe(repeat('C', 5) + repeat('K', 12));
    expect(letters(hang(5, 12, [0, 1, 2, 3, 4]).labels)).toBe(repeat('C', 5) + repeat('S', 12));
  });

  it('decides a long idle run without the write rate when the cluster has no storage write series', () => {
    const result = segmentPhases(buildInput([repeat('W', 5) + repeat('i', 12)]));
    expect(letters(result.labels)).toBe(repeat('C', 5) + repeat('S', 12));
  });
});

describe('segmentPhases: a stall needs idle CPUs', () => {
  const gpu = repeat('W', 10) + repeat('i', 20);
  const cpus = (idleLoad: number, computeLoad = 0.2) => everyNode([...Array(10).fill(computeLoad), ...Array(20).fill(idleLoad)], 1);
  const stalled = repeat('C', 10) + repeat('S', 20);
  const busy = repeat('C', 10) + repeat('u', 20);
  const labelsOf = (cpuBusy: SignalMatrix | undefined) => letters(segmentPhases(buildInput([gpu], { cpuBusy })).labels);

  it('leaves idle GPUs with CPUs as busy as during compute unclassified', () => {
    const result = segmentPhases(buildInput([gpu], { cpuBusy: cpus(0.2) }));
    expect(letters(result.labels)).toBe(busy);
    expect(result.unclassifiedReasons).toEqual([{ reason: 'gpu-idle-cpu-busy', seconds: 1200, segmentCount: 1 }]);
  });

  it('leaves CPU work that is a little less busy than compute unclassified', () => {
    // Compute at 60 % and post-processing at 54 %: the CPUs work, the job is not stalled.
    expect(labelsOf(cpus(0.54, 0.6))).toBe(busy);
    expect(labelsOf(cpus(0.59, 0.6))).toBe(busy);
    expect(labelsOf(cpus(0.3, 0.6))).toBe(busy);
  });

  it('never calls CPUs with 5 % of busy time or more idle', () => {
    const result = segmentPhases(buildInput([gpu], { cpuBusy: cpus(0.049, 0.6) }));
    expect(letters(result.labels)).toBe(stalled);
    expect(result.baselines.cpuIdleLimit).toBe(0.05);
    expect(labelsOf(cpus(0.05, 0.6))).toBe(busy);
    expect(labelsOf(cpus(0.07, 0.6))).toBe(busy);
  });

  it('calls CPUs idle only below a quarter of the compute-time load', () => {
    const result = segmentPhases(buildInput([gpu], { cpuBusy: cpus(0.024, 0.1) }));
    expect(letters(result.labels)).toBe(stalled);
    expect(result.baselines.cpuIdleLimit).toBeCloseTo(0.025, 12);
    expect(labelsOf(cpus(0.026, 0.1))).toBe(busy);
  });

  it('calls CPUs below the noise floor idle whatever the compute-time load was', () => {
    expect(labelsOf(cpus(0.009, 0.02))).toBe(stalled);
    expect(labelsOf(cpus(0.009, 0.009))).toBe(stalled);
    expect(labelsOf(cpus(0.011, 0.02))).toBe(busy);
  });

  it('uses the noise floor alone when the compute buckets have no CPU sample', () => {
    expect(labelsOf(cpus(0.009, NaN))).toBe(stalled);
    expect(labelsOf(cpus(0.011, NaN))).toBe(busy);
  });

  it('reports no stall without CPU telemetry, and says why', () => {
    const result = segmentPhases(buildInput([gpu], { cpuBusy: undefined }));
    expect(letters(result.labels)).toBe(busy);
    expect(result.unclassifiedReasons).toEqual([{ reason: 'gpu-idle-cpu-unknown', seconds: 1200, segmentCount: 1 }]);
  });

  it('reports no stall when fewer than half of the idle buckets have a CPU sample', () => {
    const partly = (known: number) => everyNode([...Array(10).fill(0.2), ...Array(known).fill(0.004), ...Array(20 - known).fill(NaN)], 1);
    expect(segmentPhases(buildInput([gpu], { cpuBusy: partly(9) })).unclassifiedReasons[0].reason).toBe('gpu-idle-cpu-unknown');
    expect(labelsOf(partly(10))).toBe(stalled);
  });

  it('judges the stretch by its median CPU load, not by its highest or its mean', () => {
    // 9 of 20 idle minutes with busy CPUs (a cron job, a health check): the median is idle.
    const spiky = everyNode([...Array(10).fill(0.2), ...Array(9).fill(0.9), ...Array(11).fill(0.004)], 1);
    expect(labelsOf(spiky)).toBe(stalled);
    const mostlyBusy = everyNode([...Array(10).fill(0.2), ...Array(11).fill(0.9), ...Array(9).fill(0.004)], 1);
    expect(labelsOf(mostlyBusy)).toBe(busy);
  });

  it('takes the compute-time load as the median of the compute buckets', () => {
    // Six compute buckets at 8 % and four at 40 %: the median is 8 %, so CPUs are idle below 2 %.
    const cpu = everyNode([...Array(6).fill(0.08), ...Array(4).fill(0.4), ...Array(20).fill(0.03)], 1);
    const result = segmentPhases(buildInput([gpu], { cpuBusy: cpu }));
    expect(result.baselines.cpuBusy).toBeCloseTo(0.08, 12);
    expect(result.baselines.cpuIdleLimit).toBeCloseTo(0.02, 12);
    expect(letters(result.labels)).toBe(busy);
  });

  it('averages the CPU load over the nodes', () => {
    // One node of two keeps its CPUs busy: the job's CPUs are not idle.
    const cpu = [Float64Array.from([...Array(10).fill(0.2), ...Array(20).fill(0.4)]), Float64Array.from([...Array(10).fill(0.2), ...Array(20).fill(0.004)])];
    expect(letters(segmentPhases(buildInput([gpu, gpu], { cpuBusy: cpu })).labels)).toBe(busy);
  });
});

describe('segmentPhases: many nodes', () => {
  it('keeps the job in compute when one node of four stalls, and reports the node', () => {
    const working = repeat('W', 40);
    const stalledNode = repeat('W', 10) + repeat('i', 25) + repeat('W', 5);
    const result = segmentPhases(buildInput([working, working, stalledNode, working]));
    expect(letters(result.labels)).toBe(repeat('C', 40));
    expect(result.nodeFindings).toEqual([{ nodeIndex: 2, fromSec: START + 600, toSec: START + 2100 }]);
    expect(result.nodeFindingCount).toBe(1);
  });

  it('does not report a node that is idle for less than the stall time', () => {
    const working = repeat('W', 40);
    const result = segmentPhases(buildInput([working, working, repeat('W', 10) + repeat('i', 9) + repeat('W', 21)]));
    expect(result.nodeFindings).toEqual([]);
  });

  it('gives no job phase when half of the nodes work and half are idle, and reports the idle nodes', () => {
    const result = segmentPhases(buildInput([repeat('W', 20), repeat('W', 20), repeat('W', 5) + repeat('i', 15), repeat('W', 5) + repeat('i', 15)]));
    expect(letters(result.labels)).toBe(repeat('C', 5) + repeat('u', 15));
    expect(result.unclassifiedReasons).toEqual([{ reason: 'nodes-disagree', seconds: 900, segmentCount: 1 }]);
    expect(result.nodeFindings).toEqual([
      { nodeIndex: 2, fromSec: START + 300, toSec: START + 1200 },
      { nodeIndex: 3, fromSec: START + 300, toSec: START + 1200 },
    ]);
  });

  it('reports the node that stops in a job of two nodes, where there is no majority', () => {
    const result = segmentPhases(buildInput([repeat('W', 30), repeat('W', 10) + repeat('i', 20)]));
    expect(letters(result.labels)).toBe(repeat('C', 10) + repeat('u', 20));
    expect(result.unclassifiedReasons[0].reason).toBe('nodes-disagree');
    expect(result.nodeFindings).toEqual([{ nodeIndex: 1, fromSec: START + 600, toSec: START + 1800 }]);
  });

  it('reports no node while every node of the job is idle', () => {
    const idle = repeat('W', 10) + repeat('i', 20);
    expect(segmentPhases(buildInput([idle, idle])).nodeFindings).toEqual([]);
  });

  it('follows the majority when most nodes are below the working level', () => {
    const idle = repeat('W', 5) + repeat('i', 15);
    const result = segmentPhases(buildInput([idle, idle, idle, repeat('W', 20)]));
    expect(letters(result.labels)).toBe(repeat('C', 5) + repeat('u', 15));
    expect(result.unclassifiedReasons[0].reason).toBe('gpu-low-write-unknown');
  });

  it('needs every node for a stall: a node without telemetry leaves the stretch unclassified', () => {
    const idle = repeat('W', 5) + repeat('i', 15);
    const result = segmentPhases(buildInput([idle, idle, idle, repeat('.', 20)]));
    expect(letters(result.labels)).toBe(repeat('C', 5) + repeat('u', 15));
    expect(result.unclassifiedReasons).toEqual([{ reason: 'gpu-idle-partial-telemetry', seconds: 900, segmentCount: 1 }]);
    expect(result.silentNodes).toEqual([3]);
  });

  it('calls a node silent only when it has no GPU sample in any bucket', () => {
    const working = repeat('W', 20);
    const result = segmentPhases(buildInput([working, repeat('.', 19) + 'W', repeat('.', 20), 'W' + repeat('.', 19)]));
    expect(result.silentNodes).toEqual([2]);
  });

  it('labels each bucket of an idle run by its own proof when a node stops reporting in it', () => {
    const idle = repeat('W', 5) + repeat('i', 15);
    const flapping = repeat('W', 5) + repeat('i', 5) + repeat('.', 5) + repeat('i', 5);
    const result = segmentPhases(buildInput([idle, idle, flapping]));
    expect(letters(result.labels)).toBe(repeat('C', 5) + repeat('S', 5) + repeat('u', 5) + repeat('S', 5));
    expect(result.reasons[12]).toBe('gpu-idle-partial-telemetry');
  });

  it('gives no job phase when at most half of the nodes report', () => {
    const result = segmentPhases(buildInput([repeat('W', 10), repeat('.', 10)]));
    expect(letters(result.labels)).toBe(repeat('u', 10));
    expect(result.unclassifiedReasons).toEqual([{ reason: 'partial-telemetry', seconds: 600, segmentCount: 1 }]);
  });

  it('lists at most twenty idle-node findings, longest first, and counts all', () => {
    const nodes = Array.from({ length: 64 }, (_, index) => (index < 25 ? repeat('W', 5) + repeat('i', 10 + index) + repeat('W', 35 - index) : repeat('W', 50)));
    const result = segmentPhases(buildInput(nodes));
    expect(result.nodeFindingCount).toBe(25);
    expect(result.nodeFindings).toHaveLength(20);
    expect(result.nodeFindings[0]).toEqual({ nodeIndex: 24, fromSec: START + 300, toSec: START + 300 + 34 * 60 });
    expect(letters(result.labels)).toBe(repeat('C', 50));
  });
});

describe('segmentPhases: missing data', () => {
  it('labels a bucket without any GPU sample as no data, not as a phase', () => {
    const result = segmentPhases(buildInput([repeat('W', 5) + repeat('.', 12) + repeat('W', 5)]));
    expect(letters(result.labels)).toBe(repeat('C', 5) + repeat('n', 12) + repeat('C', 5));
    expect(result.totals.find((total) => total.phase === 'no-data')?.seconds).toBe(720);
  });

  it('does not join two idle stretches across a gap into one stall', () => {
    const result = segmentPhases(buildInput([repeat('W', 5) + repeat('i', 6) + '.' + repeat('i', 6)]));
    expect(letters(result.labels)).toBe(repeat('C', 5) + repeat('u', 6) + 'n' + repeat('u', 6));
  });

  it('keeps a gap before the first compute bucket as no data', () => {
    expect(letters(segmentPhases(buildInput(['..ii' + repeat('W', 5)])).labels)).toBe('nnII' + repeat('C', 5));
  });

  it('returns only no data when the job has no GPU telemetry at all', () => {
    const input: PhaseInput = { startSec: START, stepSec: STEP, bucketCount: 8, nodeCount: 2, signals: { cpuBusy: everyNode(Array(8).fill(0.5), 2) } };
    const result = segmentPhases(input);
    expect(letters(result.labels)).toBe(repeat('n', 8));
    expect(result.gpuBasis).toBe('none');
    expect(result.silentNodes).toEqual([0, 1]);
    expect(result.totals).toHaveLength(1);
    expect(result.totals[0].share).toBe(1);
  });

  it('returns an empty result for an empty window', () => {
    const result = segmentPhases({ startSec: START, stepSec: STEP, bucketCount: 0, nodeCount: 1, signals: {} });
    expect(result.labels).toEqual([]);
    expect(result.segments).toEqual([]);
    expect(result.totals).toEqual([]);
  });

  it('tolerates a matrix with fewer rows than nodes', () => {
    const input = buildInput([repeat('W', 6), repeat('W', 6)]);
    input.signals.cpuBusy = [Float64Array.from(Array(6).fill(0.3))];
    expect(letters(segmentPhases(input).labels)).toBe(repeat('C', 6));
  });
});

describe('segmentPhases: one GPU signal only', () => {
  const gpu = repeat('i', 3) + repeat('W', 10) + repeat('i', 15);

  it('works on utilization alone', () => {
    const input = buildInput([gpu]);
    delete input.signals.gpuPower;
    const result = segmentPhases(input);
    expect(letters(result.labels)).toBe(repeat('I', 3) + repeat('C', 10) + repeat('S', 15));
    expect(result.gpuBasis).toBe('utilization');
    expect(result.workingLevel).toEqual({ gpuPowerWatts: null, gpuUtilPercent: 95 });
  });

  it('never reports a stall on power alone, because idle cannot be proven', () => {
    const input = buildInput([gpu]);
    delete input.signals.gpuUtilMean;
    delete input.signals.gpuUtilMax;
    const result = segmentPhases(input);
    expect(letters(result.labels)).toBe(repeat('I', 3) + repeat('C', 10) + repeat('u', 15));
    expect(result.gpuBasis).toBe('power');
    expect(result.unclassifiedReasons[0].reason).toBe('gpu-low-write-unknown');
  });

  it('does not guess when power alone is flat', () => {
    for (const flat of [repeat('W', 20), repeat('i', 20)]) {
      const input = buildInput([flat]);
      delete input.signals.gpuUtilMean;
      delete input.signals.gpuUtilMax;
      const result = segmentPhases(input);
      expect(letters(result.labels)).toBe(repeat('u', 20));
      expect(result.unclassifiedReasons).toEqual([{ reason: 'gpu-level-unknown', seconds: 1200, segmentCount: 1 }]);
    }
  });
});
