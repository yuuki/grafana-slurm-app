import { ClusterSummary, JobRecord } from '../../../api/types';
import { buildEfficiencyQueries } from './queries';
import { EFFICIENCY_DEFAULTS, resolveEfficiencySettings } from './settings';
import { planScoreWindow, ScoredWindow } from './window';

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

describe('buildEfficiencyQueries', () => {
  it('aggregates every query in PromQL over the job nodes and the bucket length', () => {
    expect(buildEfficiencyQueries(job, cluster, EFFICIENCY_DEFAULTS, windowOf(job))).toEqual({
      gpuPeak:
        'max by (instance, gpu) (max_over_time(DCGM_FI_DEV_GPU_UTIL{instance=~"(gpu-node001|gpu-node002):[0-9]+"}[60s]))',
      gpuMean:
        'avg by (instance, gpu) (avg_over_time(DCGM_FI_DEV_GPU_UTIL{instance=~"(gpu-node001|gpu-node002):[0-9]+"}[60s]))',
      gpuMemoryPeak:
        'max by (instance, gpu) (max_over_time(DCGM_FI_DEV_FB_USED{instance=~"(gpu-node001|gpu-node002):[0-9]+"}[7200s]))',
      gpuMemoryMinFree:
        'min by (instance, gpu) (min_over_time(DCGM_FI_DEV_FB_FREE{instance=~"(gpu-node001|gpu-node002):[0-9]+"}[7200s]))',
      cpuIdle: 'sum(rate(node_cpu_seconds_total{mode="idle",instance=~"(gpu-node001|gpu-node002):[0-9]+"}[300s]))',
      cpuIoWait: 'sum(rate(node_cpu_seconds_total{mode="iowait",instance=~"(gpu-node001|gpu-node002):[0-9]+"}[300s]))',
      cpuCount: 'count(rate(node_cpu_seconds_total{mode="idle",instance=~"(gpu-node001|gpu-node002):[0-9]+"}[300s]))',
    });
  });

  it('uses the configured metric names, GPU label, instance label and filter label', () => {
    const queries = buildEfficiencyQueries(
      job,
      { ...cluster, instanceLabel: 'Hostname', nodeMatcherMode: 'hostname', metricsFilterLabel: 'cluster', metricsFilterValue: 'slurm-a100' },
      resolveEfficiencySettings({
        gpuUtilizationMetric: 'nvidia_gpu_utilization',
        gpuMemoryUsedMetric: 'nvidia_gpu_memory_used',
        gpuMemoryFreeMetric: 'nvidia_gpu_memory_free',
        gpuIdLabel: 'minor_number',
      }),
      windowOf(job)
    );

    const matcher = 'Hostname=~"(gpu-node001|gpu-node002)",cluster="slurm-a100"';
    expect(queries.gpuPeak).toBe(`max by (Hostname, minor_number) (max_over_time(nvidia_gpu_utilization{${matcher}}[60s]))`);
    expect(queries.gpuMean).toBe(`avg by (Hostname, minor_number) (avg_over_time(nvidia_gpu_utilization{${matcher}}[60s]))`);
    expect(queries.gpuMemoryPeak).toBe(`max by (Hostname, minor_number) (max_over_time(nvidia_gpu_memory_used{${matcher}}[7200s]))`);
    expect(queries.gpuMemoryMinFree).toBe(`min by (Hostname, minor_number) (min_over_time(nvidia_gpu_memory_free{${matcher}}[7200s]))`);
    expect(queries.cpuIdle).toBe(`sum(rate(node_cpu_seconds_total{mode="idle",${matcher}}[300s]))`);
  });

  it('quotes dotted label names for Prometheus and keeps them bare for VictoriaMetrics', () => {
    const settings = resolveEfficiencySettings({ gpuIdLabel: 'gpu.index' });
    const dotted = { ...cluster, instanceLabel: 'host.name', nodeMatcherMode: 'hostname' as const };

    expect(buildEfficiencyQueries(job, dotted, settings, windowOf(job)).gpuPeak).toBe(
      'max by ("host.name", "gpu.index") (max_over_time(DCGM_FI_DEV_GPU_UTIL{"host.name"=~"(gpu-node001|gpu-node002)"}[60s]))'
    );
    expect(buildEfficiencyQueries(job, { ...dotted, metricsType: 'victoriametrics' }, settings, windowOf(job)).gpuPeak).toBe(
      'max by (host.name, gpu.index) (max_over_time(DCGM_FI_DEV_GPU_UTIL{host.name=~"(gpu-node001|gpu-node002)"}[60s]))'
    );
  });

  it('escapes node names and filter values with the escaping of the dashboard panels', () => {
    const odd = { ...job, nodes: ['gpu-node(001)', 'a|b', 'n.*'] };
    const queries = buildEfficiencyQueries(
      odd,
      { ...cluster, metricsFilterLabel: 'cluster', metricsFilterValue: 'a"b' },
      EFFICIENCY_DEFAULTS,
      windowOf(odd)
    );

    // Regex metacharacters of a node name cannot widen the node selection,
    // and a quote in the filter value cannot end the string.
    expect(queries.gpuPeak).toContain('instance=~"(gpu-node\\(001\\)|a\\|b|n\\.\\*):[0-9]+"');
    expect(queries.gpuPeak).toContain('cluster="a\\"b"');
  });

  it('matches no series for a job without nodes', () => {
    const empty = { ...job, nodes: [] };
    expect(buildEfficiencyQueries(empty, cluster, EFFICIENCY_DEFAULTS, windowOf(empty)).gpuPeak).toContain('instance=~"(__no_nodes__):[0-9]+"');
  });

  it('uses the bucket length for per-bucket queries and the scored window for per-job queries', () => {
    const long = { ...job, endTime: START + 3 * 86400 };
    const window = windowOf(long);
    const queries = buildEfficiencyQueries(long, cluster, EFFICIENCY_DEFAULTS, window);

    expect(window.step).toBe(1080);
    expect(queries.gpuPeak).toContain('[1080s]');
    expect(queries.gpuMean).toContain('[1080s]');
    expect(queries.gpuMemoryPeak).toContain(`[${window.buckets * 1080}s]`);
    expect(queries.gpuMemoryMinFree).toContain(`[${window.buckets * 1080}s]`);
    // The CPU rates keep a five minute window whatever the bucket length.
    expect(queries.cpuIdle).toContain('[300s]');
  });
});
