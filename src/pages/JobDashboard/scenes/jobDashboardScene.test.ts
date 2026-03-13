import { SceneQueryRunner, sceneGraph } from '@grafana/scenes';
import { ClusterSummary, JobRecord } from '../../../api/types';
import { buildJobDashboardScene } from './jobDashboardScene';
import { buildMetricExplorerEntries } from './metricDiscovery';

describe('buildJobDashboardScene', () => {
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
    submitTime: 1699999700,
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

  it('injects concrete job-specific matchers into PromQL queries', () => {
    const entries = buildMetricExplorerEntries({
      series: [{ __name__: 'DCGM_FI_DEV_GPU_UTIL', instance: 'gpu-node001:9400', 'host.name': 'gpu-node001', gpu: '0' }],
    });
    const scene = buildJobDashboardScene(job, cluster, entries, 'raw');
    const runners = sceneGraph.findAllObjects(scene, (obj) => obj instanceof SceneQueryRunner).filter((obj): obj is SceneQueryRunner => obj instanceof SceneQueryRunner);
    const expressions = runners.flatMap((runner) =>
      runner.state.queries.map((query) => String((query as { expr?: string }).expr ?? ''))
    );

    expect(expressions).toContain('DCGM_FI_DEV_GPU_UTIL{instance=~"(gpu-node001|gpu-node002):[0-9]+",cluster="slurm-a100"}');
    expect(runners).toHaveLength(1);
    expect(expressions.some((expr) => expr.includes('$gpuMatcher'))).toBe(false);
    expect(expressions.some((expr) => expr.includes('$nodeMatcher'))).toBe(false);
  });
});
