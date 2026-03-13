import { DataFrame, FieldType } from '@grafana/data';
import { SceneDataTransformer, SceneQueryRunner, sceneGraph } from '@grafana/scenes';
import { ClusterSummary, JobRecord } from '../../../api/types';
import { buildDashboardMetricQuery, buildExploreMetricQuery, buildSelectedMetricPanels, sortSeriesFramesByLegend } from './metricPanelsScene';
import { buildMetricExplorerEntries } from './metricDiscovery';

describe('buildSelectedMetricPanels', () => {
  const job: JobRecord = {
    clusterId: 'a100',
    jobId: 10001,
    name: 'train_llm',
    user: 'researcher1',
    account: 'ml-team',
    partition: 'gpu-a100',
    state: 'RUNNING',
    nodes: ['gpu-node001', 'gpu-node002'],
    nodeCount: 2,
    gpusTotal: 16,
    startTime: 1700000000,
    endTime: 0,
    exitCode: 0,
    workDir: '/tmp',
    tres: '1001=gres/gpu:16',
    templateId: 'distributed-training',
  };

  const cluster: ClusterSummary = {
    id: 'a100',
    displayName: 'A100 Cluster',
    slurmClusterName: 'slurm-a100',
    metricsDatasourceUid: 'prom-main',
    metricsType: 'prometheus',
    aggregationNodeLabels: ['host.name', 'instance'],
    instanceLabel: 'instance',
    nodeMatcherMode: 'host:port',
    defaultTemplateId: 'distributed-training',
    metricsFilterLabel: 'cluster',
    metricsFilterValue: 'slurm-a100',
  };

  const entries = buildMetricExplorerEntries({
    series: [
      { __name__: 'node_load15', instance: 'gpu-node001:9100' },
      { __name__: 'DCGM_FI_DEV_GPU_UTIL', instance: 'gpu-node001:9400', gpu: '0' },
    ],
  });

  it('renders only the selected metrics as query panels', () => {
    const gpuEntry = entries.find((entry) => entry.metricName === 'DCGM_FI_DEV_GPU_UTIL');
    expect(gpuEntry).toBeDefined();

    const scene = buildSelectedMetricPanels(job, cluster, [gpuEntry!], 'raw');
    const runners = sceneGraph
      .findAllObjects(scene, (obj) => obj instanceof SceneQueryRunner)
      .filter((obj): obj is SceneQueryRunner => obj instanceof SceneQueryRunner);
    const titles = sceneGraph
      .findAllObjects(scene, (obj) => 'state' in obj && typeof (obj as { state?: { title?: string } }).state?.title === 'string')
      .map((obj) => (obj as { state: { title?: string } }).state.title)
      .filter((title): title is string => Boolean(title));
    const expressions = runners.flatMap((runner) =>
      runner.state.queries.map((query) => String((query as { expr?: string }).expr ?? ''))
    );

    expect(runners).toHaveLength(1);
    expect(titles).toEqual(expect.arrayContaining(['DCGM_FI_DEV_GPU_UTIL']));
    expect(expressions).toContain('DCGM_FI_DEV_GPU_UTIL{instance=~"(gpu-node001|gpu-node002):[0-9]+",cluster="slurm-a100"}');
  });

  it('renders raw metrics with the shared matcher', () => {
    const customEntry = buildMetricExplorerEntries({
      series: [{ __name__: 'custom_metric', instance: 'gpu-node001:9100', device: 'eth0' }],
    });
    const scene = buildSelectedMetricPanels(job, cluster, customEntry, 'raw');
    const runners = sceneGraph
      .findAllObjects(scene, (obj) => obj instanceof SceneQueryRunner)
      .filter((obj): obj is SceneQueryRunner => obj instanceof SceneQueryRunner);
    const expressions = runners.flatMap((runner) =>
      runner.state.queries.map((query) => String((query as { expr?: string }).expr ?? ''))
    );

    expect(expressions).toEqual(['custom_metric{instance=~"(gpu-node001|gpu-node002):[0-9]+",cluster="slurm-a100"}']);
  });

  it('builds dashboard metric queries with raw legend format', () => {
    const metricQuery = buildDashboardMetricQuery(entries[0], 'raw', job, cluster);

    expect(metricQuery).toMatchObject({
      title: 'DCGM_FI_DEV_GPU_UTIL',
      legendFormat: '{{instance}} / GPU {{gpu}}',
    });
    expect(metricQuery?.expr).toBe('DCGM_FI_DEV_GPU_UTIL{instance=~"(gpu-node001|gpu-node002):[0-9]+",cluster="slurm-a100"}');
  });

  it('builds aggregated queries for raw metrics using the resolved aggregation label', () => {
    const metricQuery = buildDashboardMetricQuery(entries[0], 'aggregated', job, cluster);

    expect(metricQuery).toMatchObject({
      title: 'DCGM_FI_DEV_GPU_UTIL',
      legendFormat: '{{instance}}',
    });
    expect(metricQuery?.expr).toBe(
      'avg by(instance) (DCGM_FI_DEV_GPU_UTIL{instance=~"(gpu-node001|gpu-node002):[0-9]+",cluster="slurm-a100"})'
    );
  });

  it('prefers aggregationNodeLabels when the metric exposes them', () => {
    const metricWithNodeLabel = buildMetricExplorerEntries({
      series: [{ __name__: 'custom_metric', instance: 'gpu-node001:9100', 'host.name': 'gpu-node001', device: 'eth0' }],
    });

    const metricQuery = buildDashboardMetricQuery(metricWithNodeLabel[0], 'aggregated', job, cluster);

    expect(metricQuery).toMatchObject({
      title: 'custom_metric',
      legendFormat: '{{host.name}}',
    });
    expect(metricQuery?.expr).toBe(
      'avg by("host.name") (custom_metric{instance=~"(gpu-node001|gpu-node002):[0-9]+",cluster="slurm-a100"})'
    );
  });

  it('reuses discovered label keys for aggregated explore queries', () => {
    const metricWithNodeLabel = buildMetricExplorerEntries({
      series: [{ __name__: 'custom_metric', instance: 'gpu-node001:9100', 'host.name': 'gpu-node001', device: 'eth0' }],
    });

    const metricQuery = buildExploreMetricQuery('raw:custom_metric', job, cluster, 'aggregated', metricWithNodeLabel[0]);

    expect(metricQuery).toMatchObject({
      title: 'custom_metric',
      legendFormat: '{{host.name}}',
    });
    expect(metricQuery?.expr).toBe(
      'avg by("host.name") (custom_metric{instance=~"(gpu-node001|gpu-node002):[0-9]+",cluster="slurm-a100"})'
    );
  });

  it('wraps dashboard query runners in a legend-sorting transformer', () => {
    const scene = buildSelectedMetricPanels(job, cluster, [entries[0]], 'raw');
    const transformers = sceneGraph
      .findAllObjects(scene, (obj) => obj instanceof SceneDataTransformer)
      .filter((obj): obj is SceneDataTransformer => obj instanceof SceneDataTransformer);

    expect(transformers).toHaveLength(1);
  });

  it('sorts series frames by legend using natural ordering', () => {
    const makeFrame = (name: string): DataFrame => ({
      name,
      length: 1,
      fields: [
        { name: 'Time', type: FieldType.time, values: [0], config: {} },
        { name, type: FieldType.number, values: [1], config: {}, state: { displayName: name } },
      ],
    });

    expect(sortSeriesFramesByLegend([makeFrame('node10'), makeFrame('node2'), makeFrame('node1')]).map((frame) => frame.name)).toEqual([
      'node1',
      'node2',
      'node10',
    ]);
  });
});
