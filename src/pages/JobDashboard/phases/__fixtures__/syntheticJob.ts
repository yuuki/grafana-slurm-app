/**
 * Synthetic jobs with a known timeline, for the tests of the phase
 * segmentation. A job is generated as scraped samples (GPU gauges read at
 * scrape times, node counters that integrate a rate) and then reduced to
 * buckets the way the plugin's queries do it: avg_over_time and
 * max_over_time for gauges, the slope between the first and last sample of a
 * bucket for counters. The generator is seeded, so every run is the same.
 */
import { PhaseId, PhaseInput, SignalMatrix } from '../types';

/**
 * What the job really does. 'gap' is a short stretch with idle GPUs between
 * steps (evaluation, a data wait) and 'cpu-work' a long one with busy CPUs;
 * the segmentation must leave both unclassified.
 */
export type TruthPhase = 'init' | 'compute' | 'checkpoint' | 'stalled' | 'gap' | 'cpu-work';

export interface SyntheticStage {
  phase: TruthPhase;
  seconds: number;
}

export type SyntheticSignal = 'gpuPower' | 'gpuUtil' | 'cpu' | 'storageWrite' | 'network';

export interface SyntheticJobSpec {
  seed: number;
  nodeCount: number;
  gpusPerNode: number;
  scrapeSec: number;
  /** Job start in epoch seconds; it need not be on the bucket grid. */
  startSec: number;
  stages: SyntheticStage[];
  idleWatts: number;
  busyWatts: number;
  busyUtil: number;
  /** Relative standard deviation of GPU power and utilization while the GPU works. */
  noise: number;
  /** Nodes whose GPUs stay idle from this second of the job on, whatever the stage. */
  stalledNodes?: Array<{ node: number; fromSec: number }>;
  /** Signals that the cluster does not export. */
  without?: SyntheticSignal[];
  /** Seconds of the job in which a node (or every node) is not scraped. */
  gaps?: Array<{ node: number | 'all'; fromSec: number; toSec: number }>;
  /** Write rate of node 0 during a checkpoint, in bytes per second. */
  checkpointWriteBytesPerSecond?: number;
  /** Write rate of every node while computing, in bytes per second. */
  computeWriteBytesPerSecond?: number;
}

export const SYNTHETIC_DEFAULTS = {
  seed: 1,
  nodeCount: 2,
  gpusPerNode: 4,
  scrapeSec: 15,
  startSec: 1_750_000_007,
  idleWatts: 60,
  busyWatts: 300,
  busyUtil: 95,
  noise: 0.05,
} as const;

export function syntheticSpec(stages: SyntheticStage[], overrides: Partial<SyntheticJobSpec> = {}): SyntheticJobSpec {
  return { ...SYNTHETIC_DEFAULTS, stages, ...overrides };
}

interface Rng {
  uniform(): number;
  normal(): number;
}

/** mulberry32 with a Box-Muller transform. */
function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const uniform = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => {
    const u = Math.max(uniform(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * uniform());
  };
  return { uniform, normal };
}

export function jobSeconds(spec: SyntheticJobSpec): number {
  return spec.stages.reduce((sum, stage) => sum + stage.seconds, 0);
}

/** The stage at a second of the job (0 is the job's start). */
export function truthAt(spec: SyntheticJobSpec, second: number): TruthPhase {
  let end = 0;
  for (const stage of spec.stages) {
    end += stage.seconds;
    if (second < end) {
      return stage.phase;
    }
  }
  return spec.stages[spec.stages.length - 1].phase;
}

function nodeStalledAt(spec: SyntheticJobSpec, node: number, second: number): boolean {
  return (spec.stalledNodes ?? []).some((entry) => entry.node === node && second >= entry.fromSec);
}

function inGap(spec: SyntheticJobSpec, node: number, second: number): boolean {
  return (spec.gaps ?? []).some((gap) => (gap.node === 'all' || gap.node === node) && second >= gap.fromSec && second < gap.toSec);
}

function gpuSample(spec: SyntheticJobSpec, phase: TruthPhase, rng: Rng): { power: number; util: number } {
  if (phase === 'compute') {
    return {
      power: Math.max(spec.idleWatts, spec.busyWatts * (1 + spec.noise * rng.normal())),
      util: Math.min(100, Math.max(0, spec.busyUtil * (1 + spec.noise * rng.normal()))),
    };
  }
  const idlePower = spec.idleWatts * (1 + 0.03 * rng.normal());
  if (phase === 'stalled' || phase === 'cpu-work') {
    return { power: idlePower, util: 0 };
  }
  return { power: idlePower, util: 3 * rng.uniform() };
}

/** CPU load (0 to 1), write rate and network rate of a node in a stage. */
function nodeRates(spec: SyntheticJobSpec, phase: TruthPhase, node: number): { cpu: number; write: number; network: number } {
  const computeWrite = spec.computeWriteBytesPerSecond ?? 50e3;
  switch (phase) {
    case 'init':
      return { cpu: 0.4, write: 2e6, network: 200e3 };
    case 'compute':
      return { cpu: 0.2, write: computeWrite, network: spec.nodeCount > 1 ? 500e6 : 50e3 };
    case 'checkpoint':
      return { cpu: 0.1, write: node === 0 ? (spec.checkpointWriteBytesPerSecond ?? 200e6) : 20e3, network: 100e3 };
    case 'stalled':
      return { cpu: 0.004, write: 0, network: 20e3 };
    case 'gap':
      return { cpu: 0.05, write: 10e3, network: 100e3 };
    case 'cpu-work':
      return { cpu: 0.6, write: 30e3, network: 100e3 };
  }
}

export interface GpuSeries {
  node: number;
  gpu: number;
  /** Epoch seconds of the samples. */
  times: number[];
  power: number[];
  util: number[];
}

export interface NodeSeries {
  node: number;
  times: number[];
  /** Counters: CPU seconds that are neither idle nor iowait per CPU, bytes written, bytes on the network. */
  cpuBusySeconds: number[];
  writtenBytes: number[];
  networkBytes: number[];
}

export interface SyntheticJob {
  spec: SyntheticJobSpec;
  startSec: number;
  endSec: number;
  gpus: GpuSeries[];
  nodes: NodeSeries[];
}

function scrapeTimes(spec: SyntheticJobSpec, node: number, offset: number): number[] {
  const times: number[] = [];
  const total = jobSeconds(spec);
  for (let second = offset; second < total; second += spec.scrapeSec) {
    if (!inGap(spec, node, second)) {
      times.push(second);
    }
  }
  return times;
}

function generateGpuSeries(spec: SyntheticJobSpec, node: number, gpu: number, seconds: number[], rng: Rng): GpuSeries {
  const series: GpuSeries = { node, gpu, times: [], power: [], util: [] };
  for (const second of seconds) {
    const phase = nodeStalledAt(spec, node, second) ? 'stalled' : truthAt(spec, second);
    const sample = gpuSample(spec, phase, rng);
    series.times.push(spec.startSec + second);
    series.power.push(sample.power);
    series.util.push(sample.util);
  }
  return series;
}

function generateNodeSeries(spec: SyntheticJobSpec, node: number, seconds: number[], rng: Rng): NodeSeries {
  const series: NodeSeries = { node, times: [], cpuBusySeconds: [], writtenBytes: [], networkBytes: [] };
  const counters = { cpu: 0, write: 0, network: 0 };
  let cursor = 0;
  let stageIndex = 0;
  let stageEnd = spec.stages[0].seconds;
  for (const second of seconds) {
    // One noise factor per scrape interval; the counters integrate the rates of the stages in it.
    const factor = 1 + 0.1 * rng.normal();
    while (cursor < second) {
      while (cursor >= stageEnd && stageIndex < spec.stages.length - 1) {
        stageIndex += 1;
        stageEnd += spec.stages[stageIndex].seconds;
      }
      const until = Math.min(second, Math.max(stageEnd, cursor + 1));
      const rates = nodeRates(spec, spec.stages[stageIndex].phase, node);
      counters.cpu += (until - cursor) * Math.min(1, Math.max(0, rates.cpu * factor));
      counters.write += (until - cursor) * Math.max(0, rates.write * factor);
      counters.network += (until - cursor) * Math.max(0, rates.network * factor);
      cursor = until;
    }
    series.times.push(spec.startSec + second);
    series.cpuBusySeconds.push(counters.cpu);
    series.writtenBytes.push(counters.write);
    series.networkBytes.push(counters.network);
  }
  return series;
}

export function generateSyntheticJob(spec: SyntheticJobSpec): SyntheticJob {
  const rng = createRng(spec.seed);
  const job: SyntheticJob = { spec, startSec: spec.startSec, endSec: spec.startSec + jobSeconds(spec), gpus: [], nodes: [] };
  for (let node = 0; node < spec.nodeCount; node++) {
    // The GPU exporter and the node exporter of a node are scraped out of phase.
    const gpuSeconds = scrapeTimes(spec, node, Math.floor(rng.uniform() * spec.scrapeSec));
    const nodeSeconds = scrapeTimes(spec, node, Math.floor(rng.uniform() * spec.scrapeSec));
    for (let gpu = 0; gpu < spec.gpusPerNode; gpu++) {
      job.gpus.push(generateGpuSeries(spec, node, gpu, gpuSeconds, rng));
    }
    job.nodes.push(generateNodeSeries(spec, node, nodeSeconds, rng));
  }
  return job;
}

export interface BucketGrid {
  startSec: number;
  stepSec: number;
  bucketCount: number;
}

/** The buckets on multiples of stepSec that lie inside the job, as the plugin plans them. */
export function alignedGrid(job: SyntheticJob, stepSec: number): BucketGrid {
  const startSec = Math.ceil(job.startSec / stepSec) * stepSec;
  const endSec = Math.floor(job.endSec / stepSec) * stepSec;
  return { startSec, stepSec, bucketCount: Math.max(0, (endSec - startSec) / stepSec) };
}

function emptyMatrix(nodeCount: number, bucketCount: number): SignalMatrix {
  return Array.from({ length: nodeCount }, () => new Float64Array(bucketCount).fill(NaN));
}

/** Index of the bucket whose window (start, end] holds the time; -1 outside the grid. */
function bucketOf(grid: BucketGrid, time: number): number {
  const index = Math.ceil((time - grid.startSec) / grid.stepSec) - 1;
  return index >= 0 && index < grid.bucketCount ? index : -1;
}

interface GaugeBuckets {
  sum: Float64Array;
  count: Float64Array;
  max: Float64Array;
}

function gaugeBuckets(grid: BucketGrid, times: number[], values: number[]): GaugeBuckets {
  const buckets: GaugeBuckets = {
    sum: new Float64Array(grid.bucketCount),
    count: new Float64Array(grid.bucketCount),
    max: new Float64Array(grid.bucketCount).fill(-Infinity),
  };
  times.forEach((time, index) => {
    const bucket = bucketOf(grid, time);
    if (bucket >= 0) {
      buckets.sum[bucket] += values[index];
      buckets.count[bucket] += 1;
      buckets.max[bucket] = Math.max(buckets.max[bucket], values[index]);
    }
  });
  return buckets;
}

/** avg by (node) (avg_over_time()) and max by (node) (max_over_time()) of one gauge. */
function reduceGauge(job: SyntheticJob, grid: BucketGrid, pick: (series: GpuSeries) => number[]): { mean: SignalMatrix; max: SignalMatrix } {
  const mean = emptyMatrix(job.spec.nodeCount, grid.bucketCount);
  const max = emptyMatrix(job.spec.nodeCount, grid.bucketCount);
  const sums = emptyMatrix(job.spec.nodeCount, grid.bucketCount).map((row) => row.fill(0));
  const counts = emptyMatrix(job.spec.nodeCount, grid.bucketCount).map((row) => row.fill(0));
  for (const series of job.gpus) {
    const buckets = gaugeBuckets(grid, series.times, pick(series));
    for (let bucket = 0; bucket < grid.bucketCount; bucket++) {
      if (buckets.count[bucket] === 0) {
        continue;
      }
      sums[series.node][bucket] += buckets.sum[bucket] / buckets.count[bucket];
      counts[series.node][bucket] += 1;
      const previous = max[series.node][bucket];
      max[series.node][bucket] = Number.isFinite(previous) ? Math.max(previous, buckets.max[bucket]) : buckets.max[bucket];
    }
  }
  for (let node = 0; node < job.spec.nodeCount; node++) {
    for (let bucket = 0; bucket < grid.bucketCount; bucket++) {
      if (counts[node][bucket] > 0) {
        mean[node][bucket] = sums[node][bucket] / counts[node][bucket];
      }
    }
  }
  return { mean, max };
}

/** rate() of one counter: the slope between the first and the last sample of each bucket. */
function reduceCounter(job: SyntheticJob, grid: BucketGrid, pick: (series: NodeSeries) => number[]): SignalMatrix {
  const matrix = emptyMatrix(job.spec.nodeCount, grid.bucketCount);
  for (const series of job.nodes) {
    const values = pick(series);
    const first = new Int32Array(grid.bucketCount).fill(-1);
    const last = new Int32Array(grid.bucketCount).fill(-1);
    series.times.forEach((time, index) => {
      const bucket = bucketOf(grid, time);
      if (bucket >= 0) {
        first[bucket] = first[bucket] < 0 ? index : first[bucket];
        last[bucket] = index;
      }
    });
    for (let bucket = 0; bucket < grid.bucketCount; bucket++) {
      if (first[bucket] >= 0 && last[bucket] > first[bucket]) {
        matrix[series.node][bucket] =
          (values[last[bucket]] - values[first[bucket]]) / (series.times[last[bucket]] - series.times[first[bucket]]);
      }
    }
  }
  return matrix;
}

/** Reduces the scraped samples to the buckets of a grid, as the plugin's queries do. */
export function toPhaseInput(job: SyntheticJob, grid: BucketGrid): PhaseInput {
  const without = new Set(job.spec.without ?? []);
  const input: PhaseInput = { ...grid, nodeCount: job.spec.nodeCount, signals: {} };
  if (!without.has('gpuPower')) {
    input.signals.gpuPower = reduceGauge(job, grid, (series) => series.power).mean;
  }
  if (!without.has('gpuUtil')) {
    const util = reduceGauge(job, grid, (series) => series.util);
    input.signals.gpuUtilMean = util.mean;
    input.signals.gpuUtilMax = util.max;
  }
  if (!without.has('cpu')) {
    input.signals.cpuBusy = reduceCounter(job, grid, (series) => series.cpuBusySeconds);
  }
  if (!without.has('storageWrite')) {
    input.signals.storageWrite = reduceCounter(job, grid, (series) => series.writtenBytes);
  }
  if (!without.has('network')) {
    input.signals.network = reduceCounter(job, grid, (series) => series.networkBytes);
  }
  return input;
}

/** The label the segmentation should give a second of a stage. */
export function expectedLabel(phase: TruthPhase): PhaseId {
  return phase === 'gap' || phase === 'cpu-work' ? 'unclassified' : phase;
}

/** The stage that fills most of each bucket, and the seconds of the bucket that it fills. */
export function bucketTruth(job: SyntheticJob, grid: BucketGrid): Array<{ phase: TruthPhase; seconds: number }> {
  const truth: Array<{ phase: TruthPhase; seconds: number }> = [];
  for (let bucket = 0; bucket < grid.bucketCount; bucket++) {
    const seconds = new Map<TruthPhase, number>();
    const from = grid.startSec + bucket * grid.stepSec - job.startSec;
    for (let second = from; second < from + grid.stepSec; second++) {
      const phase = truthAt(job.spec, second);
      seconds.set(phase, (seconds.get(phase) ?? 0) + 1);
    }
    const [phase, count] = [...seconds.entries()].sort((a, b) => b[1] - a[1])[0];
    truth.push({ phase, seconds: count });
  }
  return truth;
}
