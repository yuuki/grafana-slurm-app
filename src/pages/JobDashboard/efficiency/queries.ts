import { ClusterSummary, JobRecord } from '../../../api/types';
import { buildFilterMatcher, buildInstanceMatcher, formatLabelNameForDatasource } from '../scenes/model';
import { ResolvedEfficiencySettings } from './settings';
import { ScoredWindow } from './window';

/**
 * Window of the CPU rates. Longer buckets are sampled: the rate covers the
 * last five minutes of each bucket, so the cost of the CPU queries does not
 * grow with the job's length (a node has many more CPU series than GPU
 * series).
 */
export const CPU_RATE_WINDOW_SECONDS = 300;

/**
 * node_exporter's CPU time counter. The CPU and I/O finding needs its per-CPU
 * "idle" and "iowait" modes, which the cluster's CPU Utilization Expression
 * (a percentage per node, made for the Job Search column) cannot give.
 */
const NODE_CPU_SECONDS = 'node_cpu_seconds_total';

export interface EfficiencyQueries {
  /** Range queries, one series per GPU, one point per bucket. */
  gpuPeak: string;
  gpuMean: string;
  /** Instant queries at the end of the window, one sample per GPU. */
  gpuMemoryPeak: string;
  gpuMemoryMinFree: string;
  /**
   * Range queries, one series for the whole job, one point per bucket, in
   * CPUs: idle CPUs, CPUs waiting for I/O, and the number of CPUs.
   */
  cpuIdle: string;
  cpuIoWait: string;
  cpuCount: string;
}

/**
 * Builds the scorecard's PromQL. The job's series are selected like the
 * dashboard panels select them: by the node list (buildInstanceMatcher,
 * which escapes the node names) and the cluster's optional filter label.
 * Every query aggregates in PromQL, so a response holds one value per GPU
 * and bucket, or one per bucket, never raw samples.
 */
export function buildEfficiencyQueries(
  job: JobRecord,
  cluster: ClusterSummary,
  settings: ResolvedEfficiencySettings,
  window: ScoredWindow
): EfficiencyQueries {
  const instanceMatcher = buildInstanceMatcher(job.nodes, cluster.instanceLabel, cluster.nodeMatcherMode, cluster.metricsType);
  const filterMatcher = buildFilterMatcher(cluster.metricsFilterLabel, cluster.metricsFilterValue, cluster.metricsType);
  const matcher = [instanceMatcher, filterMatcher].filter(Boolean).join(',');
  const instanceLabel = formatLabelNameForDatasource(cluster.instanceLabel, cluster.metricsType);
  const gpuLabel = formatLabelNameForDatasource(settings.gpuIdLabel, cluster.metricsType);
  const perGpu = `by (${instanceLabel}, ${gpuLabel})`;
  const bucket = `${window.step}s`;
  const whole = `${window.buckets * window.step}s`;
  const cpuRate = (mode: string) => `rate(${NODE_CPU_SECONDS}{mode="${mode}",${matcher}}[${CPU_RATE_WINDOW_SECONDS}s])`;

  return {
    gpuPeak: `max ${perGpu} (max_over_time(${settings.gpuUtilizationMetric}{${matcher}}[${bucket}]))`,
    gpuMean: `avg ${perGpu} (avg_over_time(${settings.gpuUtilizationMetric}{${matcher}}[${bucket}]))`,
    gpuMemoryPeak: `max ${perGpu} (max_over_time(${settings.gpuMemoryUsedMetric}{${matcher}}[${whole}]))`,
    gpuMemoryMinFree: `min ${perGpu} (min_over_time(${settings.gpuMemoryFreeMetric}{${matcher}}[${whole}]))`,
    cpuIdle: `sum(${cpuRate('idle')})`,
    cpuIoWait: `sum(${cpuRate('iowait')})`,
    cpuCount: `count(${cpuRate('idle')})`,
  };
}
