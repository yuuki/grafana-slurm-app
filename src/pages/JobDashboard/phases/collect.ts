/**
 * Collects the telemetry of a job and segments it into phases.
 *
 * Cost, by construction: at most four instant probes (the GPU probe at up to
 * three moments of the run, and one counter probe) and six range queries,
 * sent one after another. Every query aggregates per node in the backend,
 * and nodes x buckets stays under the point budget of plan.ts, so no
 * response grows with the number of GPUs or with the job's length. A query
 * that would be longer than MAX_QUERY_LENGTH is sent as several queries for
 * parts of the nodes, so the number of requests grows with the node count.
 * A job that cannot give a result sends as few queries as possible: none
 * when it is too short or too large, one when it allocated no GPU and its
 * nodes report none.
 */
import { ClusterSummary, JobRecord } from '../../../api/types';
import { gpuProbeTimes, PhaseWindow, PlanJob, PlanRefusal, planWindow, PROBE_RANGE_SECONDS, probeTime, scrapeIntervalFromCounts } from './plan';
import { MetricsClient, PromInstantSample, PromRangeSeries } from './promClient';
import {
  Combine,
  counterMetrics,
  PROBE_COUNT_LABEL,
  PROBE_METRIC_LABEL,
  probeQueryBuilders,
  QueryPart,
  rangeParams,
  SignalQueryBuilder,
  signalQueryBuilders,
  splitToFit,
} from './queries';
import { CPU_METRIC, EffectivePhaseSettings, NETWORK_METRICS } from './settings';
import { segmentPhases } from './segment';
import { PhaseResult, PhaseSignals, PhaseThresholds, SIGNAL_LABELS, SignalMatrix, SignalName } from './types';

export type SignalStatus =
  /** The query returned samples of the job's nodes. */
  | 'ok'
  /** The query succeeded and returned no sample of the job's nodes, and the probe found no series either. */
  | 'no-series'
  /** The series exist, but a bucket holds fewer than the two samples that a rate needs. */
  | 'too-few-samples'
  /** The values cannot be what the signal means; the signal is not used. */
  | 'invalid';

export interface SignalReport {
  signal: SignalName;
  /** The metric names the signal is read from. */
  metrics: string[];
  status: SignalStatus;
  /** Share of the node buckets with a sample, 0 to 1. */
  coverage: number;
}

export interface GpuCounts {
  /** GPUs that each node of the job reports in the probe ranges; 0 for a node that reports none. */
  perNode: number[];
  total: number;
}

export interface JobPhasesAnalysis {
  window: PhaseWindow;
  result: PhaseResult;
  signals: SignalReport[];
  /** The job's nodes, in the order of the result's node indexes. */
  nodes: string[];
  thresholds: PhaseThresholds;
  /** GPUs that the job's nodes report; null when the probe found none. */
  gpuCounts: GpuCounts | null;
  /** GPUs the job allocated, from Slurm; 0 when the allocation records none. */
  gpusAllocated: number;
  /** The job's Slurm state when it was loaded, for example RUNNING or SUSPENDED. */
  jobState: string;
  /** Points of the responses that were not on the bucket grid and were dropped. */
  droppedPoints: number;
  queryCount: number;
}

export type NotComputedReason =
  | PlanRefusal
  /** The job allocated no GPU, and its nodes report none. */
  | 'no-gpus'
  /** The job's nodes report no GPU telemetry in the window. */
  | 'no-gpu-telemetry'
  /** The job's nodes report more GPUs than the job allocated: the node averages would mix in other jobs. */
  | 'shared-nodes';

export type JobPhasesOutcome =
  | { state: 'ready'; analysis: JobPhasesAnalysis }
  | {
      state: 'not-computed';
      reason: NotComputedReason;
      stepSec?: number;
      maxNodes?: number;
      /** For too-many-nodes: the nodes of the job. */
      nodeCount?: number;
      /** For shared-nodes: the GPUs the nodes report and the GPUs the job allocated. */
      gpusReported?: number;
      gpusAllocated?: number;
      queryCount: number;
    };

/** Thrown when the caller's signal aborts the analysis between two queries. */
export class PhaseAnalysisAborted extends Error {
  constructor() {
    super('Phase analysis aborted');
    this.name = 'PhaseAnalysisAborted';
  }
}

/**
 * A query of the analysis did not return a complete result. The analysis
 * stops and gives no phases: a query that failed says nothing about the job,
 * and reading it as "no series" would turn missing evidence into a label.
 */
export class PhaseQueryFailed extends Error {
  constructor(
    /** What the query reads, for example "CPU load". */
    readonly subject: string,
    cause: unknown
  ) {
    super(`The query for ${subject} failed: ${cause instanceof Error ? cause.message : 'request failed'}`);
    this.name = 'PhaseQueryFailed';
  }
}

export interface AnalyzeOptions {
  job: JobRecord;
  cluster: ClusterSummary;
  settings: EffectivePhaseSettings;
  client: MetricsClient;
  nowSec: number;
  signal?: AbortSignal;
  /** Called before each query with the number of queries sent so far. */
  onProgress?: (sent: number) => void;
}

/** CPU load outside this range cannot come from per-CPU counters of node_exporter. */
const CPU_TOLERANCE = 0.05;
/** The smallest scrape interval the first plan assumes, to refuse a job that is too short without a query. */
const SHORTEST_SCRAPE_SECONDS = 15;

const GPU_SIGNALS: readonly SignalName[] = ['gpuUtilMax', 'gpuUtilMean', 'gpuPower'];

interface NodeIndex {
  nodes: string[];
  find(labels: Record<string, string>): number;
}

function buildNodeIndex(job: JobRecord, cluster: ClusterSummary): NodeIndex {
  const nodes = [...new Set(job.nodes)];
  const byName = new Map(nodes.map((node, index) => [node, index] as const));
  return {
    nodes,
    find(labels) {
      const instance = labels[cluster.instanceLabel];
      if (instance === undefined) {
        return -1;
      }
      const exact = byName.get(instance);
      if (exact !== undefined || cluster.nodeMatcherMode === 'hostname') {
        return exact ?? -1;
      }
      return byName.get(instance.replace(/:[0-9]+$/, '')) ?? -1;
    },
  };
}

interface Accumulator {
  values: SignalMatrix;
  counts: SignalMatrix;
  dropped: number;
}

function createAccumulator(nodeCount: number, bucketCount: number): Accumulator {
  const matrix = (fill: number) => Array.from({ length: nodeCount }, () => new Float64Array(bucketCount).fill(fill));
  return { values: matrix(NaN), counts: matrix(0), dropped: 0 };
}

function combineValues(previous: number, count: number, value: number, combine: Combine): number {
  if (count === 0) {
    return value;
  }
  if (combine === 'max') {
    return Math.max(previous, value);
  }
  return combine === 'sum' ? previous + value : (previous * count + value) / (count + 1);
}

/** Puts the points of a range result onto the bucket grid; points beside the grid are dropped and counted. */
function accumulate(accumulator: Accumulator, series: PromRangeSeries[], window: PhaseWindow, nodeIndex: NodeIndex, combine: Combine): void {
  for (const item of series) {
    const node = nodeIndex.find(item.metric);
    if (node < 0) {
      continue;
    }
    for (const [timestamp, value] of item.values) {
      const bucket = (timestamp - window.startSec) / window.stepSec - 1;
      if (!Number.isInteger(bucket) || bucket < 0 || bucket >= window.bucketCount) {
        accumulator.dropped += 1;
        continue;
      }
      const count = accumulator.counts[node][bucket];
      accumulator.values[node][bucket] = combineValues(accumulator.values[node][bucket], count, value, combine);
      accumulator.counts[node][bucket] = count + 1;
    }
  }
}

function coverage(matrix: SignalMatrix, window: PhaseWindow): number {
  const cells = matrix.length * window.bucketCount;
  let present = 0;
  for (const row of matrix) {
    for (const value of row) {
      present += Number.isFinite(value) ? 1 : 0;
    }
  }
  return cells > 0 ? present / cells : 0;
}

/** Clamps the CPU load to 0..1; false when a value is too far outside to be a rounding effect. */
function sanitizeCpu(matrix: SignalMatrix): boolean {
  for (const row of matrix) {
    for (let bucket = 0; bucket < row.length; bucket++) {
      const value = row[bucket];
      if (value < -CPU_TOLERANCE || value > 1 + CPU_TOLERANCE) {
        return false;
      }
      if (Number.isFinite(value)) {
        row[bucket] = Math.min(1, Math.max(0, value));
      }
    }
  }
  return true;
}

function metricsOf(signal: SignalName, settings: EffectivePhaseSettings): string[] {
  switch (signal) {
    case 'gpuPower':
      return [settings.gpuPowerMetric];
    case 'gpuUtilMean':
    case 'gpuUtilMax':
      return [settings.gpuUtilizationMetric];
    case 'cpuBusy':
      return [CPU_METRIC];
    case 'storageWrite':
      return [...settings.storageWriteMetrics];
    case 'network':
      return [...NETWORK_METRICS];
  }
}

type CounterSignal = 'cpuBusy' | 'storageWrite' | 'network';

interface ProbeResult {
  /** The slowest scrape interval of the GPU, CPU and storage series; null when none could be measured. */
  scrapeSec: number | null;
  gpuCounts: GpuCounts | null;
  /** The counter signals whose metrics have series in the probe range. */
  countersSeen: Set<SignalName>;
}

function sampleCounts(samples: PromInstantSample[]): number[] {
  return samples.map((sample) => Number(sample.metric[PROBE_COUNT_LABEL])).filter(Number.isFinite);
}

/** The GPU series of each node in one probe. */
function gpusPerNode(samples: PromInstantSample[], nodeIndex: NodeIndex): number[] {
  const perNode = nodeIndex.nodes.map(() => 0);
  for (const sample of samples) {
    const node = nodeIndex.find(sample.metric);
    if (node >= 0 && Number.isFinite(sample.value)) {
      perNode[node] += sample.value;
    }
  }
  return perNode;
}

/**
 * The GPUs of each node from several probes: the median of the probes in
 * which the node reports (the lower one of two). A probe in which the
 * node's exporter is silent does not count, and one in which the exporter
 * was restarted, which shows every GPU twice, is outvoted.
 */
function combineGpuCounts(probes: number[][], nodeCount: number): GpuCounts | null {
  const perNode: number[] = [];
  for (let node = 0; node < nodeCount; node++) {
    const seen = probes.map((counts) => counts[node]).filter((count) => count > 0).sort((a, b) => a - b);
    perNode.push(seen.length > 0 ? seen[Math.floor((seen.length - 1) / 2)] : 0);
  }
  const total = perNode.reduce((sum, count) => sum + count, 0);
  return total > 0 ? { perNode, total } : null;
}

function maxKnown(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length > 0 ? Math.max(...known) : null;
}

interface CounterProbe {
  seen: boolean;
  /** The slowest scrape interval of the signal's metrics; null when no metric has two samples in the probe range. */
  scrapeSec: number | null;
}

/** Per counter signal: whether its metrics have series, and their slowest scrape interval. */
function readCounterProbe(samples: PromInstantSample[], settings: EffectivePhaseSettings, rangeSeconds: number): Record<CounterSignal, CounterProbe> {
  const countsOf = (metric: string) => sampleCounts(samples.filter((sample) => sample.metric[PROBE_METRIC_LABEL] === metric));
  const metrics = counterMetrics(settings);
  const read = (signal: CounterSignal): CounterProbe => {
    const counts = metrics[signal].map(countsOf);
    return {
      seen: counts.some((own) => own.length > 0),
      scrapeSec: maxKnown(counts.map((own) => scrapeIntervalFromCounts(own, rangeSeconds))),
    };
  };
  return { cpuBusy: read('cpuBusy'), storageWrite: read('storageWrite'), network: read('network') };
}

class Analysis {
  queryCount = 0;
  droppedPoints = 0;

  constructor(private readonly options: AnalyzeOptions) {}

  private beforeQuery(): void {
    if (this.options.signal?.aborted) {
      throw new PhaseAnalysisAborted();
    }
    this.options.onProgress?.(this.queryCount);
    this.queryCount += 1;
  }

  /** Sends one query. A failure ends the analysis: it is never turned into an empty result. */
  private async send<T>(subject: string, request: () => Promise<T>): Promise<T> {
    this.beforeQuery();
    try {
      return await request();
    } catch (error) {
      if (this.options.signal?.aborted || error instanceof PhaseAnalysisAborted) {
        throw new PhaseAnalysisAborted();
      }
      throw new PhaseQueryFailed(subject, error);
    }
  }

  /** One instant query, sent in as many parts as its length needs; the samples of the parts together. */
  async instant(subject: string, parts: QueryPart[], time: number): Promise<PromInstantSample[]> {
    const samples: PromInstantSample[] = [];
    for (const part of parts) {
      samples.push(...(await this.send(subject, () => this.options.client.instant(part.expr, time))));
    }
    return samples;
  }

  async range(subject: string, parts: QueryPart[], window: PhaseWindow): Promise<PromRangeSeries[]> {
    const { start, end, step } = rangeParams(window);
    const series: PromRangeSeries[] = [];
    for (const part of parts) {
      series.push(...(await this.send(subject, () => this.options.client.range(part.expr, start, end, step))));
    }
    return series;
  }
}

async function probe(
  analysis: Analysis,
  options: AnalyzeOptions,
  planJob: PlanJob,
  nodeIndex: NodeIndex
): Promise<ProbeResult | 'no-gpus' | { sharedGpus: number }> {
  const rangeSeconds = PROBE_RANGE_SECONDS;
  const builders = probeQueryBuilders(options.settings, rangeSeconds);
  const gpuParts = splitToFit(nodeIndex.nodes, options.cluster, builders.gpu);

  const gpuProbes: number[][] = [];
  const gpuSampleCounts: number[] = [];
  for (const time of gpuProbeTimes(planJob, options.nowSec)) {
    const samples = await analysis.instant('the GPU count and scrape interval', gpuParts, time);
    const counts = gpusPerNode(samples, nodeIndex);
    if (gpuProbes.length === 0 && options.job.gpusTotal === 0 && counts.every((count) => count === 0)) {
      // No allocated GPU and none that reports at the end of the run: nothing to segment, and no further query.
      return 'no-gpus';
    }
    gpuProbes.push(counts);
    gpuSampleCounts.push(...sampleCounts(samples));
  }
  const gpuCounts = combineGpuCounts(gpuProbes, nodeIndex.nodes.length);
  if (gpuCounts !== null && options.job.gpusTotal > 0 && gpuCounts.total > options.job.gpusTotal) {
    // The queries read GPU telemetry per node. With more GPUs on the nodes than the job holds,
    // a node average is not the job's: another job's work would be reported as this job's phase.
    return { sharedGpus: gpuCounts.total };
  }

  const counterParts = splitToFit(nodeIndex.nodes, options.cluster, builders.counters);
  const counterSamples = await analysis.instant('the scrape intervals of the CPU, storage and network counters', counterParts, probeTime(planJob, options.nowSec));
  const counters = readCounterProbe(counterSamples, options.settings, rangeSeconds);
  const countersSeen = new Set<SignalName>((['cpuBusy', 'storageWrite', 'network'] as const).filter((signal) => counters[signal].seen));
  return {
    gpuCounts,
    countersSeen,
    // The network rate decides no label, so its counters do not lengthen the buckets.
    scrapeSec: maxKnown([scrapeIntervalFromCounts(gpuSampleCounts, rangeSeconds), counters.cpuBusy.scrapeSec, counters.storageWrite.scrapeSec]),
  };
}

interface Collected {
  signals: PhaseSignals;
  reports: SignalReport[];
}

interface CollectContext {
  analysis: Analysis;
  options: AnalyzeOptions;
  window: PhaseWindow;
  nodeIndex: NodeIndex;
  countersSeen: Set<SignalName>;
}

/** Why a signal has no value in any bucket. */
function emptyStatus(signal: SignalName, series: PromRangeSeries[], accumulator: Accumulator, context: CollectContext): SignalStatus {
  if (accumulator.dropped > 0) {
    // The backend answered with points beside the bucket grid: they cannot be used, and they are counted.
    return 'invalid';
  }
  // The probe saw the counters, yet the query has no point: no bucket holds the two samples of a rate.
  const empty = series.every((item) => item.values.length === 0);
  return empty && context.countersSeen.has(signal) ? 'too-few-samples' : 'no-series';
}

async function collectSignal(query: SignalQueryBuilder, context: CollectContext): Promise<{ matrix: SignalMatrix | null; report: SignalReport }> {
  const { analysis, options, window, nodeIndex } = context;
  const report: SignalReport = { signal: query.signal, metrics: metricsOf(query.signal, options.settings), status: 'no-series', coverage: 0 };
  const parts = splitToFit(nodeIndex.nodes, options.cluster, query.build);
  const series = await analysis.range(SIGNAL_LABELS[query.signal], parts, window);
  const accumulator = createAccumulator(nodeIndex.nodes.length, window.bucketCount);
  accumulate(accumulator, series, window, nodeIndex, query.combine);
  analysis.droppedPoints += accumulator.dropped;
  report.coverage = coverage(accumulator.values, window);
  if (report.coverage === 0) {
    return { matrix: null, report: { ...report, status: emptyStatus(query.signal, series, accumulator, context) } };
  }
  if (query.signal === 'cpuBusy' && !sanitizeCpu(accumulator.values)) {
    return { matrix: null, report: { ...report, status: 'invalid' } };
  }
  return { matrix: accumulator.values, report: { ...report, status: 'ok' } };
}

/** Sends the range queries in order. Without any GPU telemetry the rest is not sent, and the result is null. */
async function collectSignals(context: CollectContext): Promise<Collected | null> {
  const collected: Collected = { signals: {}, reports: [] };
  for (const query of signalQueryBuilders(context.options.settings, context.window.stepSec)) {
    const hasGpu = GPU_SIGNALS.some((signal) => collected.signals[signal] !== undefined);
    if (!GPU_SIGNALS.includes(query.signal) && !hasGpu) {
      return null;
    }
    const { matrix, report } = await collectSignal(query, context);
    collected.reports.push(report);
    if (matrix) {
      collected.signals[query.signal] = matrix;
    }
  }
  return GPU_SIGNALS.some((signal) => collected.signals[signal] !== undefined) ? collected : null;
}

function notComputed(plan: { refusal: PlanRefusal; stepSec?: number; maxNodes?: number }, queryCount: number): JobPhasesOutcome {
  return { state: 'not-computed', reason: plan.refusal, stepSec: plan.stepSec, maxNodes: plan.maxNodes, queryCount };
}

/**
 * Analyses a job. Resolves to a result or to the reason why there is none;
 * rejects with PhaseQueryFailed when any query fails, and with
 * PhaseAnalysisAborted when the signal aborts.
 */
export async function analyzeJobPhases(options: AnalyzeOptions): Promise<JobPhasesOutcome> {
  const { job, cluster, settings, nowSec } = options;
  const nodeIndex = buildNodeIndex(job, cluster);
  const planJob: PlanJob = { startTime: job.startTime, endTime: job.endTime, nodeCount: nodeIndex.nodes.length };
  const analysis = new Analysis(options);

  // Refuse what no scrape interval could make computable before sending anything.
  const early = planWindow(planJob, nowSec, SHORTEST_SCRAPE_SECONDS);
  if ('refusal' in early) {
    return { ...notComputed(early, 0), ...(early.refusal === 'too-many-nodes' ? { nodeCount: planJob.nodeCount } : {}) };
  }

  const probed = await probe(analysis, options, planJob, nodeIndex);
  if (probed === 'no-gpus') {
    return { state: 'not-computed', reason: 'no-gpus', queryCount: analysis.queryCount };
  }
  if ('sharedGpus' in probed) {
    return { state: 'not-computed', reason: 'shared-nodes', gpusReported: probed.sharedGpus, gpusAllocated: job.gpusTotal, queryCount: analysis.queryCount };
  }
  const plan = planWindow(planJob, nowSec, probed.scrapeSec);
  if ('refusal' in plan) {
    return notComputed(plan, analysis.queryCount);
  }

  const collected = await collectSignals({ analysis, options, window: plan.window, nodeIndex, countersSeen: probed.countersSeen });
  if (collected === null) {
    return { state: 'not-computed', reason: 'no-gpu-telemetry', queryCount: analysis.queryCount };
  }
  const { window } = plan;
  const result = segmentPhases(
    { startSec: window.startSec, stepSec: window.stepSec, bucketCount: window.bucketCount, nodeCount: nodeIndex.nodes.length, signals: collected.signals },
    settings.thresholds
  );
  return {
    state: 'ready',
    analysis: {
      window,
      result,
      signals: collected.reports,
      nodes: nodeIndex.nodes,
      thresholds: settings.thresholds,
      gpuCounts: probed.gpuCounts,
      gpusAllocated: job.gpusTotal,
      jobState: job.state,
      droppedPoints: analysis.droppedPoints,
      queryCount: analysis.queryCount,
    },
  };
}
