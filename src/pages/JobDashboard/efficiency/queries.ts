import { ClusterSummary, JobRecord } from '../../../api/types';
import { buildFilterMatcher, buildInstanceMatcher, escapePromRegex, formatLabelNameForDatasource } from '../scenes/model';
import { ResolvedEfficiencySettings } from './settings';
import { CpuWindows, ScoredWindow } from './window';

/**
 * node_exporter's CPU time counter. The CPU and I/O finding needs its per-CPU
 * "idle" and "iowait" modes, which the cluster's CPU Utilization Expression
 * (a percentage per node, made for the Job Search column) cannot give.
 */
const NODE_CPU_SECONDS = 'node_cpu_seconds_total';

/** Label in which the cpuSamples query returns the number of samples per CPU series. */
export const CPU_SAMPLES_LABEL = 'samples';

/** True when a PromQL string literal holds a backslash escape that PromQL does not know, such as "\.". */
function hasUnknownPromEscape(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '\\') {
      continue;
    }
    if (!/[abfnrtv\\"'xuU0-7]/.test(text[index + 1] ?? '')) {
      return true;
    }
    index++;
  }
  return false;
}

/**
 * The node names that the plugin's node matcher cannot put into a query.
 * buildInstanceMatcher escapes regex characters of a node name with one
 * backslash inside a PromQL string, and PromQL rejects a string with an
 * escape it does not know: a name with a dot ("gpu01.example.org") makes
 * the whole query fail. Such jobs are not queried at all; in Job Search
 * one of them would otherwise fail the batch of its page. The test looks
 * at what the helper produces, so it lets these names through as soon as
 * the helper escapes them in a way PromQL accepts.
 */
export function inexpressibleNodes(nodes: string[]): string[] {
  return nodes.filter((node) => /["\n]/.test(node) || hasUnknownPromEscape(escapePromRegex(node)));
}

/** The Slurm node name of an instance label value: without the exporter port in host:port mode. */
export function instanceToNode(instance: string, mode: ClusterSummary['nodeMatcherMode']): string {
  return mode === 'hostname' ? instance : instance.replace(/:[0-9]+$/, '');
}

export interface EfficiencyQueries {
  /** Range queries, one series per GPU, one point per bucket. */
  gpuPeak: string;
  gpuMean: string;
  /**
   * The same for GPU memory: the highest use and the lowest free memory of
   * each bucket. Per bucket, not over the whole job at once: one evaluation
   * then reads the samples of one bucket only, however long the job is.
   */
  gpuMemoryPeak: string;
  gpuMemoryMinFree: string;
  /**
   * Range queries over the CPU windows, one series per node, one point per
   * window, in CPUs: idle CPUs and CPUs waiting for I/O.
   */
  cpuIdle: string;
  cpuIoWait: string;
  /**
   * Range query over the CPU windows: per node and window, how many CPU
   * series hold how many samples (the count is in the CPU_SAMPLES_LABEL
   * label). It gives the number of CPUs and how densely they are scraped.
   */
  cpuSamples: string;
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
  const perNode = `by (${instanceLabel})`;
  const cpuWindow = `${cpuWindows.seconds}s`;
  const cpuRate = (mode: string) => `rate(${NODE_CPU_SECONDS}{mode="${mode}",${matcher}}[${cpuWindow}])`;

  return {
    gpuPeak: `max ${perGpu} (max_over_time(${settings.gpuUtilizationMetric}{${matcher}}[${bucket}]))`,
    gpuMean: `avg ${perGpu} (avg_over_time(${settings.gpuUtilizationMetric}{${matcher}}[${bucket}]))`,
    gpuMemoryPeak: `max ${perGpu} (max_over_time(${settings.gpuMemoryUsedMetric}{${matcher}}[${bucket}]))`,
    gpuMemoryMinFree: `min ${perGpu} (min_over_time(${settings.gpuMemoryFreeMetric}{${matcher}}[${bucket}]))`,
    cpuIdle: `sum ${perNode} (${cpuRate('idle')})`,
    cpuIoWait: `sum ${perNode} (${cpuRate('iowait')})`,
    cpuSamples: `count_values ${perNode} ("${CPU_SAMPLES_LABEL}", count_over_time(${NODE_CPU_SECONDS}{mode="idle",${matcher}}[${cpuWindow}]))`,
    gpuWindowMean: `avg ${perGpu} (avg_over_time(${settings.gpuUtilizationMetric}{${matcher}}[${cpuWindow}]))`,
  };
}
