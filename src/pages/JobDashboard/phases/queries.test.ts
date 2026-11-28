import type { ClusterSummary } from '../../../api/types';
import { buildProbeQueries, buildQueryContext, buildSignalQueries, rangeParams } from './queries';
import { EffectivePhaseSettings, resolvePhaseSettings } from './settings';

function settingsOf(overrides: Parameters<typeof resolvePhaseSettings>[0] = {}): EffectivePhaseSettings {
  const resolved = resolvePhaseSettings({ enabled: true, ...overrides });
  if (resolved.state !== 'on') {
    throw new Error('expected valid settings');
  }
  return resolved.settings;
}

const cluster: ClusterSummary = {
  id: 'cluster-a',
  displayName: 'Cluster A',
  slurmClusterName: 'cluster_a',
  metricsDatasourceUid: 'prom-a',
  metricsType: 'prometheus',
  aggregationNodeLabels: ['host.name', 'instance'],
  instanceLabel: 'instance',
  nodeMatcherMode: 'host:port',
  defaultTemplateId: 'overview',
  metricsFilterLabel: '',
  metricsFilterValue: '',
};

describe('buildQueryContext', () => {
  it('selects the nodes of the job by the instance label', () => {
    expect(buildQueryContext(['node-a001', 'node-a002'], cluster)).toEqual({
      matcher: 'instance=~"(node-a001|node-a002):[0-9]+"',
      by: 'instance',
    });
  });

  it('adds the cluster filter and supports host names without a port', () => {
    const context = buildQueryContext(['node-a001'], { ...cluster, nodeMatcherMode: 'hostname', metricsFilterLabel: 'zone', metricsFilterValue: 'zone-a' });
    expect(context.matcher).toBe('instance=~"(node-a001)",zone="zone-a"');
  });

  it('quotes an instance label that is not a plain identifier for Prometheus', () => {
    expect(buildQueryContext(['node-a001'], { ...cluster, instanceLabel: 'host.name', nodeMatcherMode: 'hostname' })).toEqual({
      matcher: '"host.name"=~"(node-a001)"',
      by: '"host.name"',
    });
  });

  it('escapes regular expression characters in node names', () => {
    expect(buildQueryContext(['node.a|x'], cluster).matcher).toBe('instance=~"(node\\.a\\|x):[0-9]+"');
  });
});

describe('buildSignalQueries', () => {
  const context = buildQueryContext(['node-a001', 'node-a002'], cluster);
  const m = 'instance=~"(node-a001|node-a002):[0-9]+"';

  it('builds one per-node query per signal, with a range of one bucket, GPU signals first', () => {
    expect(buildSignalQueries(settingsOf(), context, 120)).toEqual([
      { signal: 'gpuUtilMax', combine: 'max', expr: `max by (instance) (max_over_time(DCGM_FI_DEV_GPU_UTIL{${m}}[120s]))` },
      { signal: 'gpuUtilMean', combine: 'mean', expr: `avg by (instance) (avg_over_time(DCGM_FI_DEV_GPU_UTIL{${m}}[120s]))` },
      { signal: 'gpuPower', combine: 'mean', expr: `avg by (instance) (avg_over_time(DCGM_FI_DEV_POWER_USAGE{${m}}[120s]))` },
      {
        signal: 'cpuBusy',
        combine: 'mean',
        expr:
          `1 - sum by (instance) (rate(node_cpu_seconds_total{mode=~"idle|iowait",${m}}[120s]))` +
          ` / count by (instance) (rate(node_cpu_seconds_total{mode="idle",${m}}[120s]))`,
      },
      { signal: 'storageWrite', combine: 'sum', expr: `sum by (instance) (rate(node_disk_written_bytes_total{${m}}[120s]))` },
      {
        signal: 'network',
        combine: 'sum',
        expr:
          'sum by (instance) (rate({__name__=~"node_network_receive_bytes_total|node_network_transmit_bytes_total|' +
          `node_infiniband_port_data_received_bytes_total|node_infiniband_port_data_transmitted_bytes_total",device!="lo",${m}}[120s]))`,
      },
    ]);
  });

  it('uses the configured metric names and adds several storage write metrics', () => {
    const queries = buildSignalQueries(
      settingsOf({ gpuPowerMetric: 'gpu_power_watts', gpuUtilizationMetric: 'gpu_util_percent', storageWriteMetrics: ['a_total', 'fs:b_total'] }),
      context,
      60
    );
    expect(queries.find((query) => query.signal === 'gpuPower')?.expr).toBe(`avg by (instance) (avg_over_time(gpu_power_watts{${m}}[60s]))`);
    expect(queries.find((query) => query.signal === 'gpuUtilMax')?.expr).toBe(`max by (instance) (max_over_time(gpu_util_percent{${m}}[60s]))`);
    expect(queries.find((query) => query.signal === 'storageWrite')?.expr).toBe(`sum by (instance) (rate({__name__=~"a_total|fs:b_total",${m}}[60s]))`);
  });

  it('refuses a metric name that is not a plain name instead of putting it into a query', () => {
    const settings = { ...settingsOf(), gpuPowerMetric: 'up{} or vector(1)' };
    expect(() => buildSignalQueries(settings, context, 60)).toThrow('plain Prometheus metric names');
    expect(() => buildSignalQueries({ ...settingsOf(), storageWriteMetrics: [] }, context, 60)).toThrow('plain Prometheus metric names');
    expect(() => buildProbeQueries({ ...settingsOf(), gpuUtilizationMetric: 'a"}' }, context, 600)).toThrow('plain Prometheus metric names');
  });
});

describe('rangeParams', () => {
  it('evaluates at the end of every bucket', () => {
    const window = { startSec: 1200, endSec: 1800, stepSec: 60, bucketCount: 10, runStartSec: 1190, runEndSec: 1830, running: false, scrapeSec: 15, scrapeMeasured: true };
    expect(rangeParams(window)).toEqual({ start: 1260, end: 1800, step: 60 });
  });
});

describe('buildProbeQueries', () => {
  it('counts the series by their number of samples in the probe range', () => {
    const context = buildQueryContext(['node-a001'], cluster);
    expect(buildProbeQueries(settingsOf(), context, 3600)).toEqual({
      gpu: 'count_values by (instance) ("samples", count_over_time(DCGM_FI_DEV_GPU_UTIL{instance=~"(node-a001):[0-9]+"}[3600s]))',
      cpu: 'count_values("samples", count_over_time(node_cpu_seconds_total{mode="idle",instance=~"(node-a001):[0-9]+"}[3600s]))',
    });
  });
});
