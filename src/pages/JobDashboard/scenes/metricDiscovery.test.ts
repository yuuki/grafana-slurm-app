const mockBackendGet = jest.fn();
const mockBackendPost = jest.fn();

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({
    get: mockBackendGet,
    post: mockBackendPost,
  }),
}));

import {
  buildMetricExplorerEntries,
  buildRawMetricKey,
  discoverJobMetrics,
  getRecommendedMetricEntries,
} from './metricDiscovery';
import { ClusterSummary, JobRecord } from '../../../api/types';

describe('metric discovery', () => {
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

  beforeEach(() => {
    mockBackendGet.mockReset();
    mockBackendPost.mockReset();
  });

  it('builds distinct raw metric entries from node and gpu series with presentation overrides', () => {
    const entries = buildMetricExplorerEntries({
      nodeSeries: [
        { __name__: 'node_load15', instance: 'gpu-node001:9100' },
        { __name__: 'node_load15', instance: 'gpu-node002:9100' },
        { __name__: 'custom_metric', instance: 'gpu-node001:9100', device: 'eth0' },
      ],
      gpuSeries: [
        { __name__: 'DCGM_FI_DEV_GPU_UTIL', instance: 'gpu-node001:9400', gpu: '0' },
        { __name__: 'DCGM_FI_DEV_GPU_UTIL', instance: 'gpu-node001:9400', gpu: '1' },
      ],
    });

    expect(entries.map((entry) => entry.key)).toEqual([
      buildRawMetricKey('gpu', 'DCGM_FI_DEV_GPU_UTIL'),
      buildRawMetricKey('node', 'node_load15'),
      buildRawMetricKey('node', 'custom_metric'),
    ]);
    expect(entries[0]).toMatchObject({
      kind: 'raw',
      matcherKind: 'gpu',
      title: 'GPU Utilization',
      legendFormat: '{{instance}} / GPU {{gpu}}',
    });
    expect(entries[1]).toMatchObject({
      kind: 'raw',
      matcherKind: 'node',
      title: 'Load Average (15m)',
      legendFormat: '{{instance}}',
    });
    expect(entries[2]).toMatchObject({
      kind: 'raw',
      matcherKind: 'node',
      title: 'custom_metric',
      legendFormat: '{{instance}} {{device}}',
    });
  });

  it('keeps recommended derived views separate from raw datasource metrics', () => {
    const recommended = getRecommendedMetricEntries();

    expect(recommended).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'view',
          key: 'view:disk-read',
          title: 'Disk Read',
        }),
        expect.objectContaining({
          kind: 'view',
          key: 'view:cpu-utilization',
          title: 'CPU Utilization',
        }),
      ])
    );
  });

  it('discovers job-related metrics via node and gpu series matchers', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-11T03:55:00.000Z'));

    const querySeries = jest
      .fn<Promise<Array<Record<string, string>>>, [{ datasourceUid: string; matcher: string; from: string; to: string }]>()
      .mockResolvedValueOnce([{ __name__: 'node_load15', instance: 'gpu-node001:9100' }])
      .mockResolvedValueOnce([{ __name__: 'DCGM_FI_DEV_GPU_UTIL', instance: 'gpu-node001:9400', gpu: '0' }]);

    const result = await discoverJobMetrics({
      job,
      cluster,
      timeRange: { from: '2023-11-14T22:13:20.000Z', to: 'now' },
      querySeries,
    });

    expect(querySeries).toHaveBeenNthCalledWith(1, {
      datasourceUid: 'prom-main',
      matcher: '{instance=~"(gpu-node001|gpu-node002):9100",cluster="slurm-a100"}',
      from: '2023-11-14T22:13:20.000Z',
      to: '2026-03-11T03:55:00.000Z',
    });
    expect(querySeries).toHaveBeenNthCalledWith(2, {
      datasourceUid: 'prom-main',
      matcher: '{instance=~"(gpu-node001|gpu-node002):9400",cluster="slurm-a100"}',
      from: '2023-11-14T22:13:20.000Z',
      to: '2026-03-11T03:55:00.000Z',
    });
    expect(result.entries.map((entry) => entry.key)).toEqual([
      'raw:gpu:DCGM_FI_DEV_GPU_UTIL',
      'raw:node:node_load15',
    ]);
    expect(result.recommended).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'view:disk-read' })])
    );

    jest.useRealTimers();
  });

  it('normalizes relative time ranges before querying datasource series', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-11T03:55:00.000Z'));

    const querySeries = jest
      .fn<Promise<Array<Record<string, string>>>, [{ datasourceUid: string; matcher: string; from: string; to: string }]>()
      .mockResolvedValue([]);

    await discoverJobMetrics({
      job,
      cluster,
      timeRange: { from: '2023-11-14T22:13:20.000Z', to: 'now' },
      querySeries,
    });

    expect(querySeries).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        from: '2023-11-14T22:13:20.000Z',
        to: '2026-03-11T03:55:00.000Z',
      })
    );
    expect(querySeries).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        from: '2023-11-14T22:13:20.000Z',
        to: '2026-03-11T03:55:00.000Z',
      })
    );

    jest.useRealTimers();
  });

  it('queries Prometheus series through datasource proxy GET requests', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-11T03:55:00.000Z'));

    mockBackendGet
      .mockResolvedValueOnce({ data: [{ __name__: 'node_load15', instance: 'gpu-node001:9100' }] })
      .mockResolvedValueOnce({ data: [{ __name__: 'DCGM_FI_DEV_GPU_UTIL', instance: 'gpu-node001:9400', gpu: '0' }] });

    await discoverJobMetrics({
      job,
      cluster,
      timeRange: { from: '2023-11-14T22:13:20.000Z', to: 'now' },
    });

    expect(mockBackendGet).toHaveBeenNthCalledWith(1, '/api/datasources/proxy/uid/prom-main/api/v1/series', {
      'match[]': '{instance=~"(gpu-node001|gpu-node002):9100",cluster="slurm-a100"}',
      start: '2023-11-14T22:13:20.000Z',
      end: '2026-03-11T03:55:00.000Z',
    });
    expect(mockBackendGet).toHaveBeenNthCalledWith(2, '/api/datasources/proxy/uid/prom-main/api/v1/series', {
      'match[]': '{instance=~"(gpu-node001|gpu-node002):9400",cluster="slurm-a100"}',
      start: '2023-11-14T22:13:20.000Z',
      end: '2026-03-11T03:55:00.000Z',
    });
    expect(mockBackendPost).not.toHaveBeenCalled();

    jest.useRealTimers();
  });
});
