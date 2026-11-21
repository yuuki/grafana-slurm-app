import { ClusterSummary, JobRecord } from '../../../api/types';
import { buildFilterMatcher, buildInstanceMatcher, formatLabelNameForDatasource } from '../scenes/model';
import { ResolvedEfficiencySettings } from './settings';
import { CpuWindows, ScoredWindow } from './window';

/**
 * node_exporter's CPU time counter. The CPU and I/O finding needs its per-CPU
 * "idle" and "iowait" modes, which the cluster's CPU Utilization Expression
 * (a percentage per node, made for the Job Search column) cannot give.
 */
const NODE_CPU_SECONDS = 'node_cpu_seconds_total';

/** The Slurm node name of an instance label value: without the exporter port in host:port mode. */
export function instanceToNode(instance: string, mode: ClusterSummary['nodeMatcherMode']): string {
  return mode === 'hostname' ? instance : instance.replace(/:[0-9]+$/, '');
}

export interface EfficiencyQueries {
  /** Range queries, one series per GPU, one point per bucket. */
  gpuPeak: string;
  gpuMean: string;
  /** Instant queries at the end of the window, one sample per GPU. */
  gpuMemoryPeak: string;
  gpuMemoryMinFree: string;
  /**
   * Range queries over the CPU windows, one series per node, one point per
   * window, in CPUs: idle CPUs, CPUs waiting for I/O, and the number of CPUs.
   */
  cpuIdle: string;
  cpuIoWait: string;
  cpuCount: string;
  /** Range query over the CPU windows: each GPU's mean utilization in the same windows. */
  gpuWindowMean: string;
}

/**
 * Builds the scorecard's PromQL. The job's series are selected like the
 * dashboard panels select them: by the node list (buildInstanceMatcher,
 * which escapes the node names) and the cluster's optional filter label.
 * Every query aggregates in PromQL, so a response holds one value per GPU
 * and bucket, or one per node and CPU window, never raw samples.
 */
export function buildEfficiencyQueries(
  job: JobRecord,
  cluster: ClusterSummary,
  settings: ResolvedEfficiencySettings,
  window: ScoredWindow,
  cpuWindows: CpuWindows
): EfficiencyQueries {
  const instanceMatcher = buildInstanceMatcher(job.nodes, cluster.instanceLabel, cluster.nodeMatcherMode, cluster.metricsType);
  const filterMatcher = buildFilterMatcher(cluster.metricsFilterLabel, cluster.metricsFilterValue, cluster.metricsType);
  const matcher = [instanceMatcher, filterMatcher].filter(Boolean).join(',');
  const instanceLabel = formatLabelNameForDatasource(cluster.instanceLabel, cluster.metricsType);
  const gpuLabel = formatLabelNameForDatasource(settings.gpuIdLabel, cluster.metricsType);
  const perGpu = `by (${instanceLabel}, ${gpuLabel})`;
  const bucket = `${window.step}s`;
  const whole = `${window.buckets * window.step}s`;
  const perNode = `by (${instanceLabel})`;
  const cpuWindow = `${cpuWindows.seconds}s`;
  const cpuRate = (mode: string) => `rate(${NODE_CPU_SECONDS}{mode="${mode}",${matcher}}[${cpuWindow}])`;

  return {
    gpuPeak: `max ${perGpu} (max_over_time(${settings.gpuUtilizationMetric}{${matcher}}[${bucket}]))`,
    gpuMean: `avg ${perGpu} (avg_over_time(${settings.gpuUtilizationMetric}{${matcher}}[${bucket}]))`,
    gpuMemoryPeak: `max ${perGpu} (max_over_time(${settings.gpuMemoryUsedMetric}{${matcher}}[${whole}]))`,
    gpuMemoryMinFree: `min ${perGpu} (min_over_time(${settings.gpuMemoryFreeMetric}{${matcher}}[${whole}]))`,
    cpuIdle: `sum ${perNode} (${cpuRate('idle')})`,
    cpuIoWait: `sum ${perNode} (${cpuRate('iowait')})`,
    cpuCount: `count ${perNode} (${cpuRate('idle')})`,
    gpuWindowMean: `avg ${perGpu} (avg_over_time(${settings.gpuUtilizationMetric}{${matcher}}[${cpuWindow}]))`,
  };
}
