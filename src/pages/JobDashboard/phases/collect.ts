/**
 * Collects the telemetry of a job and segments it into phases.
 *
 * Cost, by construction: two instant probes and at most six range queries,
 * sent one after another. Every query aggregates per node in the backend,
 * and nodes x buckets stays under the point budget of plan.ts, so no
 * response grows with the number of GPUs or with the job's length. A job
 * that cannot give a result sends as few queries as possible: none when it
 * is too short or too large, one when its nodes hold GPUs of other jobs,
 * five when its nodes report no GPU telemetry.
 */
import { ClusterSummary, JobRecord } from '../../../api/types';
import { PhaseWindow, PlanJob, PlanRefusal, planWindow, PROBE_RANGE_SECONDS, probeTime, scrapeIntervalFromCounts } from './plan';
import { MetricsClient, PromInstantSample, PromRangeSeries } from './promClient';
import { buildProbeQueries, buildQueryContext, buildSignalQueries, Combine, PROBE_COUNT_LABEL, rangeParams, SignalQuery } from './queries';
import { CPU_METRIC, EffectivePhaseSettings, NETWORK_METRICS } from './settings';
import { segmentPhases } from './segment';
import { PhaseResult, PhaseSignals, PhaseThresholds, SIGNAL_LABELS, SignalMatrix, SignalName } from './types';

export type SignalStatus =
  /** The query returned samples of the job's nodes. */
  | 'ok'
  /** The query succeeded and returned no sample of the job's nodes. */
  | 'no-series'
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
  /** GPU series per node of the job in the probe range; 0 for a node that reports none. */
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

interface ProbeResult {
  scrapeSec: number | null;
  gpuCounts: GpuCounts | null;
}

function sampleCounts(samples: PromInstantSample[]): number[] {
  return samples.map((sample) => Number(sample.metric[PROBE_COUNT_LABEL])).filter(Number.isFinite);
}

function readGpuCounts(samples: PromInstantSample[], nodeIndex: NodeIndex): GpuCounts | null {
  const perNode = nodeIndex.nodes.map(() => 0);
  let total = 0;
  for (const sample of samples) {
    const node = nodeIndex.find(sample.metric);
    if (node >= 0 && Number.isFinite(sample.value)) {
      perNode[node] += sample.value;
      total += sample.value;
    }
  }
  return total > 0 ? { perNode, total } : null;
}

function maxKnown(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length > 0 ? Math.max(...known) : null;
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

  instant(subject: string, expr: string, time: number): Promise<PromInstantSample[]> {
    return this.send(subject, () => this.options.client.instant(expr, time));
  }

  range(subject: string, expr: string, window: PhaseWindow): Promise<PromRangeSeries[]> {
    const { start, end, step } = rangeParams(window);
    return this.send(subject, () => this.options.client.range(expr, start, end, step));
  }
}

async function probe(
  analysis: Analysis,
  options: AnalyzeOptions,
  planJob: PlanJob,
  nodeIndex: NodeIndex
): Promise<ProbeResult | 'no-gpus' | { sharedGpus: number }> {
  const context = buildQueryContext(nodeIndex.nodes, options.cluster);
  const rangeSeconds = PROBE_RANGE_SECONDS;
  const queries = buildProbeQueries(options.settings, context, rangeSeconds);
  const time = probeTime(planJob, options.nowSec);

  const gpuSamples = await analysis.instant('the GPU count and scrape interval', queries.gpu, time);
  const gpuCounts = readGpuCounts(gpuSamples, nodeIndex);
  if (gpuCounts === null && options.job.gpusTotal === 0) {
    // No allocated GPU and none that reports: nothing to segment, and no further query.
    return 'no-gpus';
  }
  if (gpuCounts !== null && options.job.gpusTotal > 0 && gpuCounts.total > options.job.gpusTotal) {
    // The queries read GPU telemetry per node. With more GPUs on the nodes than the job holds,
    // a node average is not the job's: another job's work would be reported as this job's phase.
    return { sharedGpus: gpuCounts.total };
  }
  const cpuSamples = await analysis.instant('the CPU scrape interval', queries.cpu, time);
  return {
    gpuCounts,
    scrapeSec: maxKnown([
      scrapeIntervalFromCounts(sampleCounts(gpuSamples), rangeSeconds),
      scrapeIntervalFromCounts(sampleCounts(cpuSamples), rangeSeconds),
    ]),
  };
}

interface Collected {
  signals: PhaseSignals;
  reports: SignalReport[];
}

async function collectSignal(
  analysis: Analysis,
  query: SignalQuery,
  window: PhaseWindow,
  nodeIndex: NodeIndex,
  settings: EffectivePhaseSettings
): Promise<{ matrix: SignalMatrix | null; report: SignalReport }> {
  const report: SignalReport = { signal: query.signal, metrics: metricsOf(query.signal, settings), status: 'no-series', coverage: 0 };
  const series = await analysis.range(SIGNAL_LABELS[query.signal], query.expr, window);
  const accumulator = createAccumulator(nodeIndex.nodes.length, window.bucketCount);
  accumulate(accumulator, series, window, nodeIndex, query.combine);
  analysis.droppedPoints += accumulator.dropped;
  report.coverage = coverage(accumulator.values, window);
  if (report.coverage === 0) {
    return { matrix: null, report };
  }
  if (query.signal === 'cpuBusy' && !sanitizeCpu(accumulator.values)) {
    return { matrix: null, report: { ...report, status: 'invalid' } };
  }
  return { matrix: accumulator.values, report: { ...report, status: 'ok' } };
}

/** Sends the range queries in order. Without any GPU telemetry the rest is not sent, and the result is null. */
async function collectSignals(analysis: Analysis, options: AnalyzeOptions, window: PhaseWindow, nodeIndex: NodeIndex): Promise<Collected | null> {
  const context = buildQueryContext(nodeIndex.nodes, options.cluster);
  const collected: Collected = { signals: {}, reports: [] };
  for (const query of buildSignalQueries(options.settings, context, window.stepSec)) {
    const hasGpu = GPU_SIGNALS.some((signal) => collected.signals[signal] !== undefined);
    if (!GPU_SIGNALS.includes(query.signal) && !hasGpu) {
      return null;
    }
    const { matrix, report } = await collectSignal(analysis, query, window, nodeIndex, options.settings);
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
    return notComputed(early, 0);
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

  const collected = await collectSignals(analysis, options, plan.window, nodeIndex);
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
