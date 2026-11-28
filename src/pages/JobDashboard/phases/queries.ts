/**
 * The PromQL of the job phase segmentation. Every query aggregates per node
 * in the backend, so a response holds one series per node and one point per
 * bucket, whatever the number of GPUs, CPUs or devices.
 *
 * A range query is evaluated at the end of each bucket with a range selector
 * of one bucket, so the windows do not overlap and each point describes
 * exactly one bucket. The queries use only *_over_time, rate and plain
 * aggregation, which Prometheus and VictoriaMetrics evaluate alike.
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

/** The range queries, GPU signals first: without them the others are not sent. */
export function buildSignalQueries(settings: EffectivePhaseSettings, context: QueryContext, stepSec: number): SignalQuery[] {
  const { matcher, by } = context;
  const range = `[${stepSec}s]`;
  const power = selector(settings.gpuPowerMetric, matcher);
  const util = selector(settings.gpuUtilizationMetric, matcher);
  const cpuIdle = selector(CPU_METRIC, `mode="idle",${matcher}`);
  const cpuNotBusy = selector(CPU_METRIC, `mode=~"idle|iowait",${matcher}`);
  return [
    { signal: 'gpuUtilMax', combine: 'max', expr: `max by (${by}) (max_over_time(${util}${range}))` },
    { signal: 'gpuUtilMean', combine: 'mean', expr: `avg by (${by}) (avg_over_time(${util}${range}))` },
    { signal: 'gpuPower', combine: 'mean', expr: `avg by (${by}) (avg_over_time(${power}${range}))` },
    {
      // The share of CPU time that is neither idle nor waiting for I/O.
      signal: 'cpuBusy',
      combine: 'mean',
      expr: `1 - sum by (${by}) (rate(${cpuNotBusy}${range})) / count by (${by}) (rate(${cpuIdle}${range}))`,
    },
    { signal: 'storageWrite', combine: 'sum', expr: rateSum(settings.storageWriteMetrics, matcher, range, by) },
    // The loopback interface carries no traffic between nodes or to storage.
    { signal: 'network', combine: 'sum', expr: rateSum(NETWORK_METRICS, `device!="lo",${matcher}`, range, by) },
  ];
}

/** The parameters of a range query that is evaluated at the end of every bucket of the window. */
export function rangeParams(window: PhaseWindow): { start: number; end: number; step: number } {
  return { start: window.startSec + window.stepSec, end: window.endSec, step: window.stepSec };
}

/** Label that carries the sample count in the probe results. */
export const PROBE_COUNT_LABEL = 'samples';

/**
 * The probes: per node and sample count, the number of GPU series in the
 * probe range; and per sample count, the number of CPU series. They give the
 * scrape intervals and the number of GPUs that each node reports.
 */
export function buildProbeQueries(settings: EffectivePhaseSettings, context: QueryContext, rangeSeconds: number): { gpu: string; cpu: string } {
  const { matcher, by } = context;
  const util = selector(settings.gpuUtilizationMetric, matcher);
  const cpuIdle = selector(CPU_METRIC, `mode="idle",${matcher}`);
  return {
    gpu: `count_values by (${by}) ("${PROBE_COUNT_LABEL}", count_over_time(${util}[${rangeSeconds}s]))`,
    cpu: `count_values("${PROBE_COUNT_LABEL}", count_over_time(${cpuIdle}[${rangeSeconds}s]))`,
  };
}
