import { SceneQueryRunner, sceneGraph } from '@grafana/scenes';
import { ClusterSummary, JobRecord } from '../../../api/types';
import { buildSelectedMetricPanels } from './metricPanelsScene';
import { buildRawMetricKey } from './metricDiscovery';

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
    instanceLabel: 'instance',
    nodeExporterPort: '9100',
    dcgmExporterPort: '9400',
    nodeMatcherMode: 'host:port',
    defaultTemplateId: 'distributed-training',
    metricsFilterLabel: 'cluster',
    metricsFilterValue: 'slurm-a100',
  };

  it('renders only the selected metrics as query panels', () => {
    const scene = buildSelectedMetricPanels(job, cluster, [
      buildRawMetricKey('gpu', 'DCGM_FI_DEV_GPU_UTIL'),
      'view:disk-read',
    ]);
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

    expect(runners).toHaveLength(2);
    expect(titles).toEqual(expect.arrayContaining(['GPU Utilization', 'Disk Read']));
    expect(expressions).toContain('DCGM_FI_DEV_GPU_UTIL{instance=~"(gpu-node001|gpu-node002):9400",cluster="slurm-a100"}');
    expect(expressions).toContain('rate(node_disk_read_bytes_total{instance=~"(gpu-node001|gpu-node002):9100",cluster="slurm-a100"}[5m])');
  });

  it('renders raw node metrics without curated expressions', () => {
    const scene = buildSelectedMetricPanels(job, cluster, [buildRawMetricKey('node', 'custom_metric')]);
    const runners = sceneGraph
      .findAllObjects(scene, (obj) => obj instanceof SceneQueryRunner)
      .filter((obj): obj is SceneQueryRunner => obj instanceof SceneQueryRunner);
    const expressions = runners.flatMap((runner) =>
      runner.state.queries.map((query) => String((query as { expr?: string }).expr ?? ''))
    );

    expect(expressions).toEqual(['custom_metric{instance=~"(gpu-node001|gpu-node002):9100",cluster="slurm-a100"}']);
  });
});
