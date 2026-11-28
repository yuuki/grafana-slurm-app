import type { ClusterSummary } from '../../../api/types';
import { buildInstanceMatcher } from '../scenes/model';
import {
  buildProbeQueries,
  buildQueryContext,
  buildSignalQueries,
  MAX_QUERY_LENGTH,
  probeQueryBuilders,
  rangeParams,
  rateShift,
  signalQueryBuilders,
  splitToFit,
} from './queries';
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

  it("takes the node matcher from the plugin's shared helper, like every other query of the plugin", () => {
    const nodes = ['node-a001', 'node-a002'];
    expect(buildQueryContext(nodes, cluster).matcher).toBe(buildInstanceMatcher(nodes, 'instance', 'host:port', 'prometheus'));
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
        expr: `1 - avg by (instance) (sum by (instance, cpu) (rate(node_cpu_seconds_total{mode=~"idle|iowait",${m}}[120s])))`,
      },
      { signal: 'storageWrite', combine: 'sum', expr: `sum by (instance) (rate(node_disk_written_bytes_total{${m}}[120s]))` },
      {
        signal: 'network',
        combine: 'sum',
        expr:
          'sum by (instance) (' +
          [
            'node_network_receive_bytes_total',
            'node_network_transmit_bytes_total',
            'node_infiniband_port_data_received_bytes_total',
            'node_infiniband_port_data_transmitted_bytes_total',
          ]
            .map((name) => `label_replace(rate(${name}{device!="lo",${m}}[120s]), "phase_metric", "${name}", "", "")`)
            .join(' or ') +
          ')',
      },
    ]);
  });

  it('gives each of several counters its own rate(), because one selector for metrics with equal labels fails on Prometheus', () => {
    const queries = buildSignalQueries(settingsOf({ storageWriteMetrics: ['a_total', 'fs:b_total'] }), context, 60);
    const write = queries.find((query) => query.signal === 'storageWrite')?.expr;
    expect(write).toBe(
      `sum by (instance) (label_replace(rate(a_total{${m}}[60s]), "phase_metric", "a_total", "", "")` +
        ` or label_replace(rate(fs:b_total{${m}}[60s]), "phase_metric", "fs:b_total", "", ""))`
    );
    expect(write).not.toContain('__name__');
  });

  it('uses the configured metric names', () => {
    const queries = buildSignalQueries(
      settingsOf({ gpuPowerMetric: 'gpu_power_watts', gpuUtilizationMetric: 'gpu_util_percent', storageWriteMetrics: ['a_total', 'fs:b_total'] }),
      context,
      60
    );
    expect(queries.find((query) => query.signal === 'gpuPower')?.expr).toBe(`avg by (instance) (avg_over_time(gpu_power_watts{${m}}[60s]))`);
    expect(queries.find((query) => query.signal === 'gpuUtilMax')?.expr).toBe(`max by (instance) (max_over_time(gpu_util_percent{${m}}[60s]))`);
  });

  it('refuses a metric name that is not a plain name instead of putting it into a query', () => {
    const settings = { ...settingsOf(), gpuPowerMetric: 'up{} or vector(1)' };
    expect(() => buildSignalQueries(settings, context, 60)).toThrow('plain Prometheus metric names');
    expect(() => buildSignalQueries({ ...settingsOf(), storageWriteMetrics: [] }, context, 60)).toThrow('plain Prometheus metric names');
    expect(() => buildProbeQueries({ ...settingsOf(), gpuUtilizationMetric: 'a"}' }, context, 600)).toThrow('plain Prometheus metric names');
  });
});

describe('rangeParams', () => {
  const window = { startSec: 1200, endSec: 1800, stepSec: 60, bucketCount: 10, runStartSec: 1190, runEndSec: 1830, running: false, scrapeSec: 15, scrapeMeasured: true };

  it('evaluates at the end of every bucket', () => {
    expect(rangeParams(window)).toEqual({ start: 1260, end: 1800, step: 60 });
  });

  it('evaluates a shifted query the same number of times, later', () => {
    expect(rangeParams(window, 540)).toEqual({ start: 1800, end: 2340, step: 60 });
  });
});

describe('rateShift', () => {
  it('puts a rate window that is longer than the bucket around the bucket, on the bucket grid', () => {
    // A window of one bucket ends with the bucket.
    expect(rateShift(60, 60)).toBe(0);
    // Two buckets cannot be centred on the grid: the window ends with the bucket.
    expect(rateShift(60, 120)).toBe(0);
    expect(rateShift(60, 180)).toBe(60);
    expect(rateShift(60, 240)).toBe(60);
    // 20 buckets for a counter scraped every 300 s: from 11 minutes before the end of the bucket to 9 minutes after it.
    expect(rateShift(60, 1200)).toBe(540);
    expect(rateShift(120, 1200)).toBe(480);
  });
});

describe('rate windows of slow counters', () => {
  const context = buildQueryContext(['node-a001'], cluster);
  const m = 'instance=~"(node-a001):[0-9]+"';

  it('reads the storage and network rates over their own windows and everything else over the bucket', () => {
    const queries = buildSignalQueries(settingsOf(), context, 60, { storageWrite: 1200, network: 240 });
    const expr = (signal: string) => queries.find((query) => query.signal === signal)!.expr;
    expect(expr('storageWrite')).toBe(`sum by (instance) (rate(node_disk_written_bytes_total{${m}}[1200s]))`);
    expect(expr('network')).toContain(`rate(node_network_receive_bytes_total{device!="lo",${m}}[240s])`);
    expect(expr('network')).not.toContain('[60s]');
    for (const signal of ['gpuUtilMax', 'gpuUtilMean', 'gpuPower', 'cpuBusy']) {
      expect(expr(signal)).toContain('[60s]');
    }
  });
});

describe('buildProbeQueries', () => {
  const context = buildQueryContext(['node-a001'], cluster);
  const m = 'instance=~"(node-a001):[0-9]+"';
  const counted = (selector: string, name: string) => `label_replace(count_over_time(${selector}[600s]), "phase_metric", "${name}", "", "")`;

  it('counts the GPU series per node by their number of samples in the probe range', () => {
    expect(buildProbeQueries(settingsOf(), context, 600).gpu).toBe(`count_values by (instance) ("samples", count_over_time(DCGM_FI_DEV_GPU_UTIL{${m}}[600s]))`);
  });

  it('counts the series of every counter per metric, so that each scrape interval can be measured', () => {
    const settings = settingsOf({ storageWriteMetrics: ['node_disk_written_bytes_total', 'lustre_write_bytes_total'] });
    expect(buildProbeQueries(settings, context, 600).counters).toBe(
      'count_values by (phase_metric) ("samples", ' +
        [
          counted(`node_cpu_seconds_total{mode="idle",${m}}`, 'node_cpu_seconds_total'),
          counted(`node_disk_written_bytes_total{${m}}`, 'node_disk_written_bytes_total'),
          counted(`lustre_write_bytes_total{${m}}`, 'lustre_write_bytes_total'),
          ...['node_network_receive_bytes_total', 'node_network_transmit_bytes_total', 'node_infiniband_port_data_received_bytes_total', 'node_infiniband_port_data_transmitted_bytes_total'].map(
            (name) => counted(`${name}{device!="lo",${m}}`, name)
          ),
        ].join(' or ') +
        ')'
    );
  });
});

describe('splitToFit', () => {
  const nodes = Array.from({ length: 2000 }, (_, index) => `node-a${String(index).padStart(4, '0')}-rack`);
  const settings = settingsOf();

  it('sends one query when it fits', () => {
    const build = signalQueryBuilders(settings, 60)[0].build;
    const parts = splitToFit(nodes.slice(0, 50), cluster, build);
    expect(parts).toEqual([{ nodes: nodes.slice(0, 50), expr: build(buildQueryContext(nodes.slice(0, 50), cluster)) }]);
  });

  it('keeps every query of a 2000-node job under the limit, also the network query that names the nodes four times', () => {
    const builders = [...signalQueryBuilders(settings, 60).map((query) => query.build), ...Object.values(probeQueryBuilders(settings, 600))];
    for (const build of builders) {
      const parts = splitToFit(nodes, cluster, build);
      expect(Math.max(...parts.map((part) => part.expr.length))).toBeLessThanOrEqual(MAX_QUERY_LENGTH);
      // Every node is in exactly one part, in order, and each part is the query for its own nodes.
      expect(parts.flatMap((part) => part.nodes)).toEqual(nodes);
      parts.forEach((part) => expect(part.expr).toBe(build(buildQueryContext(part.nodes, cluster))));
    }
    // The whole job in one network query would be several times the default limit of VictoriaMetrics (16384).
    const network = signalQueryBuilders(settings, 60)[5].build;
    expect(network(buildQueryContext(nodes, cluster)).length).toBeGreaterThan(16_384);
    expect(MAX_QUERY_LENGTH).toBeLessThan(16_384);
  });

  it('keeps a quarter of the default limit of VictoriaMetrics (16384) as margin', () => {
    expect(MAX_QUERY_LENGTH).toBeLessThanOrEqual(0.75 * 16_384);
    expect(MAX_QUERY_LENGTH).toBeGreaterThanOrEqual(8_000);
  });

  it('sends a query of exactly the limit whole, and splits one that is a character longer', () => {
    const build = signalQueryBuilders(settings, 60)[0].build;
    const three = ['node-a001', 'node-a002', 'node-a003'];
    const length = build(buildQueryContext(three, cluster)).length;
    expect(splitToFit(three, cluster, build, length)).toHaveLength(1);
    expect(splitToFit(three, cluster, build, length - 1).length).toBeGreaterThan(1);
  });

  it('splits an odd number of nodes with the larger half first, so two of three nodes share a query when they fit', () => {
    const build = signalQueryBuilders(settings, 60)[0].build;
    const three = ['node-a001', 'node-a002', 'node-a003'];
    const two = build(buildQueryContext(three.slice(0, 2), cluster)).length;
    expect(splitToFit(three, cluster, build, two).map((part) => part.nodes)).toEqual([['node-a001', 'node-a002'], ['node-a003']]);
    const five = ['n1', 'n2', 'n3', 'n4', 'n5'];
    const fitsThree = build(buildQueryContext(five.slice(0, 3), cluster)).length;
    expect(splitToFit(five, cluster, build, fitsThree).map((part) => part.nodes)).toEqual([['n1', 'n2', 'n3'], ['n4', 'n5']]);
  });

  it('does not split one node, whatever the length of the query', () => {
    const build = signalQueryBuilders(settings, 60)[0].build;
    expect(splitToFit(['node-a001'], cluster, build, 10)).toHaveLength(1);
    expect(splitToFit(['node-a001', 'node-a002', 'node-a003'], cluster, build, 10).map((part) => part.nodes)).toEqual([['node-a001'], ['node-a002'], ['node-a003']]);
  });
});
