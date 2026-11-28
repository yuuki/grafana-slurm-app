/**
 * The PromQL of the job phase segmentation. Every query aggregates per node
 * in the backend, so a response holds one series per node and one point per
 * bucket, whatever the number of GPUs, CPUs or devices.
 *
 * A range query is evaluated at the end of each bucket with a range selector
 * of one bucket, so the windows do not overlap and each point describes
 * exactly one bucket. The queries use only *_over_time, rate and plain
 * aggregation, which Prometheus and VictoriaMetrics evaluate alike.
 *
 * A query names every node it reads, so it grows with the job. splitToFit
 * keeps each query under MAX_QUERY_LENGTH by sending several queries for
 * disjoint parts of the nodes.
 */
import { ClusterSummary } from '../../../api/types';
import { buildFilterMatcher, buildInstanceMatcher, formatLabelNameForDatasource } from '../scenes/model';
import { PhaseWindow } from './plan';
import { CPU_METRIC, EffectivePhaseSettings, isPhaseMetricName, NETWORK_METRICS } from './settings';
import { SignalName } from './types';

/** How the values of two series of one node are combined (two exporters on one host). */
export type Combine = 'mean' | 'max' | 'sum';

export interface SignalQuery {
  signal: SignalName;
  expr: string;
  combine: Combine;
}

export interface QueryContext {
  /** Label matchers that select the job's nodes, and the cluster's filter. */
  matcher: string;
  /** The instance label, formatted for the datasource. */
  by: string;
}

export function buildQueryContext(nodes: string[], cluster: ClusterSummary): QueryContext {
  const instanceMatcher = buildInstanceMatcher(nodes, cluster.instanceLabel, cluster.nodeMatcherMode, cluster.metricsType);
  const filterMatcher = buildFilterMatcher(cluster.metricsFilterLabel, cluster.metricsFilterValue, cluster.metricsType);
  return {
    matcher: [instanceMatcher, filterMatcher].filter(Boolean).join(','),
    by: formatLabelNameForDatasource(cluster.instanceLabel, cluster.metricsType),
  };
}

/** A selector for one metric. The name goes into the query unquoted, so only a plain metric name is accepted. */
function selector(metric: string, matchers: string): string {
  if (!isPhaseMetricName(metric)) {
    throw new Error('Phase queries need plain Prometheus metric names');
  }
  return `${metric}{${matchers}}`;
}

/** Label that keeps the rates of different metrics apart until they are added. */
const METRIC_LABEL = 'phase_metric';

/**
 * The rates of one or more counters, added per node.
 *
 * rate() drops the metric name, so two metrics whose series carry the same
 * labels (receive and transmit bytes of one interface) would collide in one
 * selector: Prometheus refuses that with "vector cannot contain metrics with
 * the same labelset". Each metric therefore gets its own rate(), marked with
 * a label, and `or` joins them before the sum.
 */
function rateSum(metrics: readonly string[], matchers: string, range: string, by: string): string {
  if (metrics.length === 0) {
    throw new Error('Phase queries need plain Prometheus metric names');
  }
  const rates = metrics.map((metric) => `rate(${selector(metric, matchers)}${range})`);
  if (rates.length === 1) {
    return `sum by (${by}) (${rates[0]})`;
  }
  const marked = rates.map((rate, index) => `label_replace(${rate}, "${METRIC_LABEL}", "${metrics[index]}", "", "")`);
  return `sum by (${by}) (${marked.join(' or ')})`;
}

export interface SignalQueryBuilder {
  signal: SignalName;
  combine: Combine;
  /** The query for the nodes that the context selects. */
  build(context: QueryContext): string;
}

/** The builders of the range queries, GPU signals first: without them the others are not sent. */
export function signalQueryBuilders(settings: EffectivePhaseSettings, stepSec: number): SignalQueryBuilder[] {
  const range = `[${stepSec}s]`;
  const util = (matcher: string) => selector(settings.gpuUtilizationMetric, matcher);
  return [
    { signal: 'gpuUtilMax', combine: 'max', build: ({ matcher, by }) => `max by (${by}) (max_over_time(${util(matcher)}${range}))` },
    { signal: 'gpuUtilMean', combine: 'mean', build: ({ matcher, by }) => `avg by (${by}) (avg_over_time(${util(matcher)}${range}))` },
    {
      signal: 'gpuPower',
      combine: 'mean',
      build: ({ matcher, by }) => `avg by (${by}) (avg_over_time(${selector(settings.gpuPowerMetric, matcher)}${range}))`,
    },
    {
      // The share of CPU time that is neither idle nor waiting for I/O: per CPU, the idle and
      // iowait rates add up to the share that is not busy; the node's value is the mean over
      // its CPUs. The node matcher is in the query once, which keeps the query short.
      signal: 'cpuBusy',
      combine: 'mean',
      build: ({ matcher, by }) =>
        `1 - avg by (${by}) (sum by (${by}, cpu) (rate(${selector(CPU_METRIC, `mode=~"idle|iowait",${matcher}`)}${range})))`,
    },
    { signal: 'storageWrite', combine: 'sum', build: ({ matcher, by }) => rateSum(settings.storageWriteMetrics, matcher, range, by) },
    // The loopback interface carries no traffic between nodes or to storage.
    { signal: 'network', combine: 'sum', build: ({ matcher, by }) => rateSum(NETWORK_METRICS, `${NETWORK_MATCHER},${matcher}`, range, by) },
  ];
}

const NETWORK_MATCHER = 'device!="lo"';

/** The range queries for one set of nodes. */
export function buildSignalQueries(settings: EffectivePhaseSettings, context: QueryContext, stepSec: number): SignalQuery[] {
  return signalQueryBuilders(settings, stepSec).map(({ signal, combine, build }) => ({ signal, combine, expr: build(context) }));
}

/** The parameters of a range query that is evaluated at the end of every bucket of the window. */
export function rangeParams(window: PhaseWindow): { start: number; end: number; step: number } {
  return { start: window.startSec + window.stepSec, end: window.endSec, step: window.stepSec };
}

/** Label that carries the sample count in the probe results. */
export const PROBE_COUNT_LABEL = 'samples';
/** Label that carries the metric name in the result of the counter probe. */
export const PROBE_METRIC_LABEL = METRIC_LABEL;

/** The counters whose scrape interval the counter probe measures, by the signal they feed. */
export function counterMetrics(settings: EffectivePhaseSettings): Record<'cpuBusy' | 'storageWrite' | 'network', readonly string[]> {
  return { cpuBusy: [CPU_METRIC], storageWrite: settings.storageWriteMetrics, network: NETWORK_METRICS };
}

/**
 * The probes.
 *
 * - gpu: per node and sample count, the number of GPU series in the probe
 *   range. It gives the GPU scrape interval and the GPUs that each node
 *   reports.
 * - counters: per counter metric and sample count, the number of series in
 *   the probe range. It gives the scrape interval of the CPU, storage and
 *   network counters. A rate needs two samples in its range, so the bucket
 *   must follow the slowest counter that decides a label, not only the GPU
 *   exporter.
 */
export function probeQueryBuilders(
  settings: EffectivePhaseSettings,
  rangeSeconds: number
): { gpu: (context: QueryContext) => string; counters: (context: QueryContext) => string } {
  const range = `[${rangeSeconds}s]`;
  const counted = (metric: string, matcher: string) =>
    `label_replace(count_over_time(${selector(metric, matcher)}${range}), "${PROBE_METRIC_LABEL}", "${metric}", "", "")`;
  const metrics = counterMetrics(settings);
  return {
    gpu: ({ matcher, by }) => `count_values by (${by}) ("${PROBE_COUNT_LABEL}", count_over_time(${selector(settings.gpuUtilizationMetric, matcher)}${range}))`,
    counters: ({ matcher }) => {
      const parts = [
        counted(CPU_METRIC, `mode="idle",${matcher}`),
        ...metrics.storageWrite.map((metric) => counted(metric, matcher)),
        ...metrics.network.map((metric) => counted(metric, `${NETWORK_MATCHER},${matcher}`)),
      ];
      return `count_values by (${PROBE_METRIC_LABEL}) ("${PROBE_COUNT_LABEL}", ${parts.join(' or ')})`;
    },
  };
}

/** The probe queries for one set of nodes. */
export function buildProbeQueries(settings: EffectivePhaseSettings, context: QueryContext, rangeSeconds: number): { gpu: string; counters: string } {
  const builders = probeQueryBuilders(settings, rangeSeconds);
  return { gpu: builders.gpu(context), counters: builders.counters(context) };
}

/**
 * Queries are kept under this length. The node names are in every query (in
 * the network query four times), so a query grows with the job.
 * VictoriaMetrics refuses a query over 16,384 bytes by default
 * (-search.maxQueryLen); this limit leaves a margin for node names that are
 * not ASCII.
 */
export const MAX_QUERY_LENGTH = 12_000;

export interface QueryPart {
  /** The nodes this query selects. */
  nodes: string[];
  expr: string;
}

/**
 * The query for the nodes, or several queries for disjoint parts of the
 * nodes when one query would be longer than maxLength. Every query
 * aggregates per node, so the results of the parts are simply put together.
 * A part of one node is not split further, whatever its length.
 */
export function splitToFit(
  nodes: string[],
  cluster: ClusterSummary,
  build: (context: QueryContext) => string,
  maxLength = MAX_QUERY_LENGTH
): QueryPart[] {
  const expr = build(buildQueryContext(nodes, cluster));
  if (expr.length <= maxLength || nodes.length <= 1) {
    return [{ nodes, expr }];
  }
  const half = Math.ceil(nodes.length / 2);
  return [...splitToFit(nodes.slice(0, half), cluster, build, maxLength), ...splitToFit(nodes.slice(half), cluster, build, maxLength)];
}
