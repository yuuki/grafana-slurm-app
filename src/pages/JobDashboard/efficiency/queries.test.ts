import { ClusterSummary, JobRecord } from '../../../api/types';
import { buildEfficiencyQueries } from './queries';
import { EFFICIENCY_DEFAULTS, resolveEfficiencySettings } from './settings';
import { planCpuWindows, planScoreWindow, ScoredWindow } from './window';

// A multiple of 60, so the two hour job below has 120 one-minute buckets.
const START = 1_700_000_040;

const cluster: ClusterSummary = {
  id: 'a100',
  displayName: 'A100',
  slurmClusterName: 'gpu_cluster',
  metricsDatasourceUid: 'prom-main',
  metricsType: 'prometheus',
  aggregationNodeLabels: ['instance'],
  instanceLabel: 'instance',
  nodeMatcherMode: 'host:port',
  defaultTemplateId: 'overview',
  metricsFilterLabel: '',
  metricsFilterValue: '',
};

const job: JobRecord = {
  clusterId: 'a100',
  jobId: 1,
  name: 'train',
  user: 'researcher1',
  account: 'ml-team',
  partition: 'gpu-a100',
  state: 'COMPLETED',
  nodes: ['gpu-node001', 'gpu-node002'],
  nodeList: 'gpu-node[001-002]',
  nodeCount: 2,
  gpusTotal: 16,
  cpusTotal: 256,
  submitTime: START - 60,
  startTime: START,
  endTime: START + 7200,
  exitCode: 0,
  workDir: '/tmp',
  tres: '1=256,1001=16',
  templateId: 'overview',
};

function windowOf(target: JobRecord): ScoredWindow {
  const window = planScoreWindow(target, START + 100_000);
  if (window.status !== 'ok') {
    throw new Error('expected a scored window');
  }
  return window;
}

function queriesOf(target: JobRecord, targetCluster: ClusterSummary = cluster, settings = EFFICIENCY_DEFAULTS) {
  const window = windowOf(target);
  return buildEfficiencyQueries(target, targetCluster, settings, window, planCpuWindows(window));
}

describe('buildEfficiencyQueries', () => {
  it('aggregates every query in PromQL over the job nodes and the bucket length', () => {
    expect(queriesOf(job)).toEqual({
      gpuPeak:
        'max by (instance, gpu) (max_over_time(DCGM_FI_DEV_GPU_UTIL{instance=~"(gpu-node001|gpu-node002):[0-9]+"}[60s]))',
      gpuMean:
        'avg by (instance, gpu) (avg_over_time(DCGM_FI_DEV_GPU_UTIL{instance=~"(gpu-node001|gpu-node002):[0-9]+"}[60s]))',
      gpuMemoryPeak:
        'max by (instance, gpu) (max_over_time(DCGM_FI_DEV_FB_USED{instance=~"(gpu-node001|gpu-node002):[0-9]+"}[60s]))',
      gpuMemoryMinFree:
        'min by (instance, gpu) (min_over_time(DCGM_FI_DEV_FB_FREE{instance=~"(gpu-node001|gpu-node002):[0-9]+"}[60s]))',
      cpuIdle: 'sum by (instance) (rate(node_cpu_seconds_total{mode="idle",instance=~"(gpu-node001|gpu-node002):[0-9]+"}[300s]))',
      cpuIoWait: 'sum by (instance) (rate(node_cpu_seconds_total{mode="iowait",instance=~"(gpu-node001|gpu-node002):[0-9]+"}[300s]))',
      cpuSamples:
        'count_values by (instance) ("samples", count_over_time(node_cpu_seconds_total{mode="idle",instance=~"(gpu-node001|gpu-node002):[0-9]+"}[300s]))',
      gpuWindowMean:
        'avg by (instance, gpu) (avg_over_time(DCGM_FI_DEV_GPU_UTIL{instance=~"(gpu-node001|gpu-node002):[0-9]+"}[300s]))',
    });
  });

  it('uses the configured metric names, GPU label, instance label and filter label', () => {
    const queries = queriesOf(
      job,
      { ...cluster, instanceLabel: 'Hostname', nodeMatcherMode: 'hostname', metricsFilterLabel: 'cluster', metricsFilterValue: 'slurm-a100' },
      resolveEfficiencySettings({
        gpuUtilizationMetric: 'nvidia_gpu_utilization',
        gpuMemoryUsedMetric: 'nvidia_gpu_memory_used',
        gpuMemoryFreeMetric: 'nvidia_gpu_memory_free',
        gpuIdLabel: 'minor_number',
      })
    );

    const matcher = 'Hostname=~"(gpu-node001|gpu-node002)",cluster="slurm-a100"';
    expect(queries.gpuPeak).toBe(`max by (Hostname, minor_number) (max_over_time(nvidia_gpu_utilization{${matcher}}[60s]))`);
    expect(queries.gpuMean).toBe(`avg by (Hostname, minor_number) (avg_over_time(nvidia_gpu_utilization{${matcher}}[60s]))`);
    expect(queries.gpuMemoryPeak).toBe(`max by (Hostname, minor_number) (max_over_time(nvidia_gpu_memory_used{${matcher}}[60s]))`);
    expect(queries.gpuMemoryMinFree).toBe(`min by (Hostname, minor_number) (min_over_time(nvidia_gpu_memory_free{${matcher}}[60s]))`);
    expect(queries.cpuIdle).toBe(`sum by (Hostname) (rate(node_cpu_seconds_total{mode="idle",${matcher}}[300s]))`);
    expect(queries.cpuSamples).toBe(`count_values by (Hostname) ("samples", count_over_time(node_cpu_seconds_total{mode="idle",${matcher}}[300s]))`);
    expect(queries.gpuWindowMean).toBe(`avg by (Hostname, minor_number) (avg_over_time(nvidia_gpu_utilization{${matcher}}[300s]))`);
  });

  it('quotes dotted label names for Prometheus and keeps them bare for VictoriaMetrics', () => {
    const settings = resolveEfficiencySettings({ gpuIdLabel: 'gpu.index' });
    const dotted = { ...cluster, instanceLabel: 'host.name', nodeMatcherMode: 'hostname' as const };

    expect(queriesOf(job, dotted, settings).gpuPeak).toBe(
      'max by ("host.name", "gpu.index") (max_over_time(DCGM_FI_DEV_GPU_UTIL{"host.name"=~"(gpu-node001|gpu-node002)"}[60s]))'
    );
    expect(queriesOf(job, { ...dotted, metricsType: 'victoriametrics' }, settings).gpuPeak).toBe(
      'max by (host.name, gpu.index) (max_over_time(DCGM_FI_DEV_GPU_UTIL{host.name=~"(gpu-node001|gpu-node002)"}[60s]))'
    );
  });

  it('escapes node names and filter values with the escaping of the dashboard panels', () => {
    const odd = { ...job, nodes: ['gpu-node(001)', 'a|b', 'n.*'] };
    const queries = queriesOf(odd, { ...cluster, metricsFilterLabel: 'cluster', metricsFilterValue: 'a"b' });

    // Regex metacharacters of a node name cannot widen the node selection,
    // and a quote in the filter value cannot end the string.
    // Each regex escape is written with two backslashes: the PromQL string
    // turns "n\\.\\*" into the regex n\.\*, which matches only the name "n.*".
    expect(queries.gpuPeak).toContain('instance=~"(gpu-node\\\\(001\\\\)|a\\\\|b|n\\\\.\\\\*):[0-9]+"');
    expect(queries.gpuPeak).toContain('cluster="a\\"b"');
  });

  it('matches no series for a job without nodes', () => {
    const empty = { ...job, nodes: [] };
    expect(queriesOf(empty).gpuPeak).toContain('instance=~"(__no_nodes__):[0-9]+"');
  });

  it('never reads more than one bucket, or five minutes of CPU counters, in one evaluation', () => {
    const long = { ...job, endTime: START + 3 * 86400 };
    const window = windowOf(long);
    const queries = queriesOf(long);

    expect(window.step).toBe(1080);
    expect(queries.gpuPeak).toContain('[1080s]');
    expect(queries.gpuMean).toContain('[1080s]');
    expect(queries.gpuMemoryPeak).toContain('[1080s]');
    expect(queries.gpuMemoryMinFree).toContain('[1080s]');
    // No range selector spans the whole job.
    for (const query of Object.values(queries)) {
      expect(query).toMatch(/\[(1080|300)s\]/);
    }
    // The CPU windows stay five minutes long whatever the bucket length.
    expect(queries.cpuIdle).toContain('[300s]');
    expect(queries.cpuIoWait).toContain('[300s]');
    expect(queries.cpuSamples).toContain('[300s]');
    expect(queries.gpuWindowMean).toContain('[300s]');
  });
});
