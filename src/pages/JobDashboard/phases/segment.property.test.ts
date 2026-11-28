/**
 * Properties of segmentPhases that must hold for every input, checked on
 * random inputs from a seeded generator (the same inputs on every run).
 */
import { CPU_IDLE_MAX, CPU_NOISE_FLOOR, DEFAULT_PHASE_THRESHOLDS, quantile, segmentPhases } from './segment';
import { PhaseInput, PhaseResult, PhaseSignals, PhaseThresholds, SIGNAL_NAMES, SignalMatrix } from './types';

const CASES = 200;

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface RandomCase {
  input: PhaseInput;
  thresholds: PhaseThresholds;
}

/**
 * A job as runs of GPU regimes per node (working, low, idle, no telemetry),
 * with noise, and optional CPU, write and network series with their own gaps.
 */
function randomCase(seed: number): RandomCase {
  const random = createRandom(seed);
  const between = (low: number, high: number) => low + random() * (high - low);
  const nodeCount = 1 + Math.floor(random() * 6);
  const bucketCount = 1 + Math.floor(random() * 120);
  const stepSec = [60, 120, 300, 900][Math.floor(random() * 4)];
  const busyWatts = between(80, 700);
  const idleWatts = between(20, 0.45 * busyWatts);
  const busyUtil = between(30, 100);
  const empty = (): SignalMatrix => Array.from({ length: nodeCount }, () => new Float64Array(bucketCount).fill(NaN));
  const gpuPower = empty();
  const gpuUtilMean = empty();
  const gpuUtilMax = empty();

  for (let node = 0; node < nodeCount; node++) {
    let bucket = 0;
    while (bucket < bucketCount) {
      const regime = random();
      const length = 1 + Math.floor(random() * 30);
      for (let i = 0; i < length && bucket < bucketCount; i++, bucket++) {
        if (regime < 0.1) {
          continue;
        }
        if (regime < 0.55) {
          gpuPower[node][bucket] = busyWatts * between(0.8, 1.1);
          gpuUtilMean[node][bucket] = busyUtil * between(0.8, 1);
          gpuUtilMax[node][bucket] = 100;
        } else if (regime < 0.7) {
          gpuPower[node][bucket] = between(idleWatts, 0.45 * busyWatts);
          gpuUtilMean[node][bucket] = between(0, 0.4 * busyUtil);
          gpuUtilMax[node][bucket] = between(6, 100);
        } else {
          gpuPower[node][bucket] = idleWatts * between(0.95, 1.05);
          gpuUtilMean[node][bucket] = between(0, 2);
          gpuUtilMax[node][bucket] = between(0, 5);
        }
      }
    }
  }

  const auxiliary = (low: number, high: number): SignalMatrix =>
    empty().map((row) => row.map(() => (random() < 0.1 ? NaN : random() < 0.15 ? between(high, 50 * high) : between(low, high))));
  const signals: PhaseSignals = {};
  const keep = () => random() < 0.8;
  if (keep()) {
    signals.gpuPower = gpuPower;
  }
  if (keep()) {
    signals.gpuUtilMean = gpuUtilMean;
    signals.gpuUtilMax = gpuUtilMax;
  }
  if (keep()) {
    // Half of the jobs have CPUs that are idle most of the time, so that stalls occur.
    signals.cpuBusy = random() < 0.5 ? auxiliary(0, 1) : auxiliary(0, 0.008);
  }
  if (keep()) {
    signals.storageWrite = auxiliary(0, 400e3);
  }
  if (keep()) {
    signals.network = auxiliary(0, 1e8);
  }
  return {
    input: { startSec: 1_750_000_000 + Math.floor(random() * 1000) * stepSec, stepSec, bucketCount, nodeCount, signals },
    thresholds: {
      idleGpuUtilizationPercent: 5,
      stallMinSeconds: [60, 600, 1800][Math.floor(random() * 3)],
      checkpointMinWriteBytesPerSecond: [0, 1024 * 1024][Math.floor(random() * 2)],
    },
  };
}

function forEachCase(check: (testCase: RandomCase, result: PhaseResult, seed: number) => void): void {
  for (let seed = 1; seed <= CASES; seed++) {
    const testCase = randomCase(seed);
    check(testCase, segmentPhases(testCase.input, testCase.thresholds), seed);
  }
}

function hasGpuSample(input: PhaseInput, bucket: number): boolean {
  const { gpuPower, gpuUtilMean, gpuUtilMax } = input.signals;
  return [gpuPower, gpuUtilMean, gpuUtilMax].some((matrix) => matrix?.some((row) => Number.isFinite(row[bucket])) ?? false);
}

function jobWrite(input: PhaseInput, bucket: number): number {
  const values = (input.signals.storageWrite ?? []).map((row) => row[bucket]).filter(Number.isFinite);
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : NaN;
}

function jobCpu(input: PhaseInput, bucket: number): number {
  const values = (input.signals.cpuBusy ?? []).map((row) => row[bucket]).filter(Number.isFinite);
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
}

/** The first and last bucket of the run around `bucket` in which `member` holds. */
function runAround(bucket: number, bucketCount: number, member: (bucket: number) => boolean): [number, number] {
  let from = bucket;
  let to = bucket;
  while (from > 0 && member(from - 1)) {
    from--;
  }
  while (to + 1 < bucketCount && member(to + 1)) {
    to++;
  }
  return [from, to];
}

function medianOf(values: number[]): number {
  return quantile(values, 0.5) ?? NaN;
}

function scaled(input: PhaseInput, name: keyof PhaseSignals, factor: number): PhaseInput {
  const matrix = input.signals[name];
  return matrix ? { ...input, signals: { ...input.signals, [name]: matrix.map((row) => row.map((value) => value * factor)) } } : input;
}

describe('segmentPhases properties', () => {
  it('covers the window with segments that neither overlap nor leave a gap', () => {
    forEachCase(({ input }, result) => {
      expect(result.labels).toHaveLength(input.bucketCount);
      let cursor = input.startSec;
      const wrong = result.segments.filter((segment, index) => {
        const previous = result.segments[index - 1];
        const ok =
          segment.fromSec === cursor &&
          segment.toSec > segment.fromSec &&
          (segment.toSec - segment.fromSec) % input.stepSec === 0 &&
          !(previous !== undefined && previous.phase === segment.phase && previous.reason === segment.reason);
        cursor = segment.toSec;
        return !ok;
      });
      expect(wrong).toEqual([]);
      expect(cursor).toBe(input.startSec + input.bucketCount * input.stepSec);
    });
  });

  it('gives totals that add up to the window and shares that add up to 1', () => {
    forEachCase(({ input }, result) => {
      const seconds = result.totals.reduce((sum, total) => sum + total.seconds, 0);
      expect(seconds).toBe(input.bucketCount * input.stepSec);
      expect(result.totals.reduce((sum, total) => sum + total.share, 0)).toBeCloseTo(1, 12);
      expect(result.totals.reduce((sum, total) => sum + total.segmentCount, 0)).toBe(result.segments.length);
      const unclassified = result.totals.find((total) => total.phase === 'unclassified')?.seconds ?? 0;
      expect(result.unclassifiedReasons.reduce((sum, total) => sum + total.seconds, 0)).toBe(unclassified);
    });
  });

  it('gives a reason to every unclassified bucket and to no other', () => {
    forEachCase((_, result) => {
      const wrong = result.labels.filter((label, bucket) => (result.reasons[bucket] !== undefined) !== (label === 'unclassified'));
      expect(wrong).toEqual([]);
    });
  });

  it('labels a bucket as no data exactly when no node has a GPU sample in it', () => {
    forEachCase(({ input }, result) => {
      const wrong = result.labels.filter((label, bucket) => (label === 'no-data') === hasGpuSample(input, bucket));
      expect(wrong).toEqual([]);
    });
  });

  it('turns a bucket into no data when its GPU samples are removed', () => {
    forEachCase(({ input, thresholds }, result, seed) => {
      const removed = seed % input.bucketCount;
      const signals: PhaseSignals = { ...input.signals };
      for (const name of ['gpuPower', 'gpuUtilMean', 'gpuUtilMax'] as const) {
        signals[name] = input.signals[name]?.map((row) => {
          const copy = Float64Array.from(row);
          copy[removed] = NaN;
          return copy;
        });
      }
      const without = segmentPhases({ ...input, signals }, thresholds);
      expect(without.labels[removed]).toBe('no-data');
    });
  });

  it('reports a stall only for a run of the stall time in which every GPU of every node is proven idle, after compute', () => {
    forEachCase(({ input, thresholds }, result) => {
      const firstCompute = result.labels.indexOf('compute');
      for (const segment of result.segments.filter((item) => item.phase === 'stalled')) {
        const from = (segment.fromSec - input.startSec) / input.stepSec;
        const to = (segment.toSec - input.startSec) / input.stepSec;
        expect(firstCompute).toBeGreaterThanOrEqual(0);
        expect(from).toBeGreaterThan(firstCompute);
        for (let bucket = from; bucket < to; bucket++) {
          for (let node = 0; node < input.nodeCount; node++) {
            expect(input.signals.gpuUtilMax![node][bucket]).toBeLessThanOrEqual(thresholds.idleGpuUtilizationPercent);
          }
        }
      }
      // The idle run of a stall may hold buckets in which a node did not report; the run as a whole has the stall time.
      const inIdleRun = (bucket: number) => result.labels[bucket] === 'stalled' || result.reasons[bucket] === 'gpu-idle-partial-telemetry';
      result.labels.forEach((label, bucket) => {
        if (label !== 'stalled') {
          return;
        }
        let from = bucket;
        let to = bucket;
        while (from > 0 && inIdleRun(from - 1)) {
          from--;
        }
        while (to + 1 < input.bucketCount && inIdleRun(to + 1)) {
          to++;
        }
        expect((to - from + 1) * input.stepSec).toBeGreaterThanOrEqual(thresholds.stallMinSeconds);
      });
    });
  });

  it('reports a stall only when the CPUs of the idle run are idle too', () => {
    forEachCase(({ input }, result) => {
      const inIdleRun = (bucket: number) => result.labels[bucket] === 'stalled' || result.reasons[bucket] === 'gpu-idle-partial-telemetry';
      result.labels.forEach((label, bucket) => {
        if (label !== 'stalled') {
          return;
        }
        const [from, to] = runAround(bucket, input.bucketCount, inIdleRun);
        const cpu: number[] = [];
        for (let index = from; index <= to; index++) {
          cpu.push(jobCpu(input, index));
        }
        const known = cpu.filter(Number.isFinite);
        expect(2 * known.length).toBeGreaterThanOrEqual(cpu.length);
        expect(medianOf(known)).toBeLessThan(result.baselines.cpuIdleLimit);
        expect(result.baselines.cpuIdleLimit).toBeGreaterThanOrEqual(CPU_NOISE_FLOOR);
        expect(result.baselines.cpuIdleLimit).toBeLessThanOrEqual(CPU_IDLE_MAX);
      });
    });
  });

  it('reports a checkpoint only with a write rate at burst level: in the bucket, or in most of a long idle run', () => {
    forEachCase(({ input, thresholds }, result) => {
      const burst = result.baselines.writeBurstBytesPerSecond;
      expect(burst).toBeGreaterThanOrEqual(thresholds.checkpointMinWriteBytesPerSecond);
      result.labels.forEach((label, bucket) => {
        if (label !== 'checkpoint' || jobWrite(input, bucket) >= burst) {
          return;
        }
        // Not a burst in this bucket: then the bucket lies in an idle run of the stall time whose median write rate is a burst.
        const [from, to] = runAround(bucket, input.bucketCount, (index) => result.labels[index] === 'checkpoint');
        const writes: number[] = [];
        for (let index = from; index <= to; index++) {
          writes.push(jobWrite(input, index));
        }
        expect((to - from + 1) * input.stepSec).toBeGreaterThanOrEqual(thresholds.stallMinSeconds);
        expect(medianOf(writes.filter(Number.isFinite))).toBeGreaterThanOrEqual(burst);
      });
    });
  });

  it('reports startup only before the first compute bucket, and compute at all for it', () => {
    forEachCase((_, result) => {
      const firstCompute = result.labels.indexOf('compute');
      result.labels.forEach((label, bucket) => {
        if (label === 'init') {
          expect(firstCompute).toBeGreaterThan(bucket);
        }
        if (bucket < firstCompute) {
          expect(['init', 'unclassified', 'no-data']).toContain(label);
        }
      });
    });
  });

  it('claims nothing that needs a missing signal', () => {
    forEachCase(({ input, thresholds }) => {
      const noWrite = segmentPhases({ ...input, signals: { ...input.signals, storageWrite: undefined } }, thresholds);
      expect(noWrite.labels).not.toContain('checkpoint');
      const noUtil = segmentPhases({ ...input, signals: { ...input.signals, gpuUtilMean: undefined, gpuUtilMax: undefined } }, thresholds);
      expect(noUtil.labels).not.toContain('stalled');
      const noGpu = segmentPhases({ ...input, signals: { ...input.signals, gpuPower: undefined, gpuUtilMean: undefined, gpuUtilMax: undefined } }, thresholds);
      expect(noGpu.labels.every((label) => label === 'no-data')).toBe(true);
    });
  });

  it('does not depend on the unit of GPU power', () => {
    forEachCase(({ input, thresholds }, result, seed) => {
      const factor = [0.001, 0.37, 2, 1000][seed % 4];
      const other = segmentPhases(scaled(input, 'gpuPower', factor), thresholds);
      expect(other.labels).toEqual(result.labels);
      expect(other.reasons).toEqual(result.reasons);
    });
  });

  it('does not depend on the unit of the write rate when the smallest write rate is zero', () => {
    forEachCase(({ input, thresholds }, _result, seed) => {
      const relative = { ...thresholds, checkpointMinWriteBytesPerSecond: 0 };
      const factor = [0.001, 0.37, 8, 1000][seed % 4];
      const base = segmentPhases(input, relative);
      const other = segmentPhases(scaled(input, 'storageWrite', factor), relative);
      expect(other.labels).toEqual(base.labels);
    });
  });

  it('does not depend on the network rate, which is evidence only', () => {
    forEachCase(({ input, thresholds }, result) => {
      const other = segmentPhases({ ...input, signals: { ...input.signals, network: undefined } }, thresholds);
      expect(other.labels).toEqual(result.labels);
      expect(other.reasons).toEqual(result.reasons);
    });
  });

  it('does not depend on the order of the nodes or on the start time', () => {
    forEachCase(({ input, thresholds }, result) => {
      const reversed: PhaseSignals = {};
      for (const name of SIGNAL_NAMES) {
        const matrix = input.signals[name];
        if (matrix) {
          reversed[name] = [...matrix].reverse();
        }
      }
      const other = segmentPhases({ ...input, startSec: input.startSec + 86400, signals: reversed }, thresholds);
      expect(other.labels).toEqual(result.labels);
      expect(other.reasons).toEqual(result.reasons);
    });
  });

  it('is deterministic and does not change its input', () => {
    forEachCase(({ input, thresholds }, result) => {
      const snapshot = JSON.stringify(SIGNAL_NAMES.map((name) => input.signals[name]?.map((row) => Array.from(row))));
      expect(segmentPhases(input, thresholds)).toEqual(result);
      expect(JSON.stringify(SIGNAL_NAMES.map((name) => input.signals[name]?.map((row) => Array.from(row))))).toBe(snapshot);
    });
  });

  it('keeps coverage between 0 and 1 and reports 0 for a missing signal', () => {
    forEachCase(({ input }, result) => {
      for (const name of SIGNAL_NAMES) {
        expect(result.coverage[name]).toBeGreaterThanOrEqual(0);
        expect(result.coverage[name]).toBeLessThanOrEqual(1);
        if (!input.signals[name]) {
          expect(result.coverage[name]).toBe(0);
        }
      }
    });
  });

  it('produces every label and every reason somewhere in the random cases', () => {
    const labels = new Set<string>();
    const reasons = new Set<string>();
    forEachCase((_, result) => {
      result.labels.forEach((label) => labels.add(label));
      result.reasons.forEach((reason) => reason && reasons.add(reason));
    });
    expect([...labels].sort()).toEqual(['checkpoint', 'compute', 'init', 'no-data', 'stalled', 'unclassified']);
    expect([...reasons].sort()).toEqual([
      'gpu-idle-cpu-busy',
      'gpu-idle-cpu-unknown',
      'gpu-idle-partial-telemetry',
      'gpu-idle-short',
      'gpu-level-unknown',
      'gpu-low',
      'gpu-low-write-unknown',
      'no-compute',
      'nodes-disagree',
      'partial-telemetry',
    ]);
  });

  it('uses the default thresholds when none are given', () => {
    const { input } = randomCase(7);
    expect(segmentPhases(input)).toEqual(segmentPhases(input, DEFAULT_PHASE_THRESHOLDS));
  });
});
