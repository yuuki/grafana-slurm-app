const mockBackendGet = jest.fn();
const mockBackendPost = jest.fn();

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({
    get: mockBackendGet,
    post: mockBackendPost,
  }),
}));

import { buildMetricExplorerEntries, buildRawMetricKey, discoverJobMetrics, inferMetricTypeFromName, PrometheusMetricType } from './metricDiscovery';
import { ClusterSummary, JobRecord } from '../../../api/types';

describe('inferMetricTypeFromName', () => {
  it.each([
    ['node_cpu_seconds_total', 'counter'],
    ['node_network_receive_bytes_total', 'counter'],
    ['DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL', 'counter'],
    ['http_request_duration_seconds_bucket', 'histogram'],
    ['http_request_duration_seconds_count', 'counter'],
    ['http_request_duration_seconds_sum', 'counter'],
    ['DCGM_FI_DEV_GPU_UTIL', 'unknown'],
    ['node_load15', 'unknown'],
    ['node_memory_MemTotal_bytes', 'unknown'],
  ] as const)('infers %s as %s', (metricName, expected) => {
    expect(inferMetricTypeFromName(metricName)).toBe(expected);
  });
});

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
    nodeList: 'gpu-node[001-002]',
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

  beforeEach(() => {
    mockBackendGet.mockReset();
    mockBackendPost.mockReset();
  });

  it('builds raw metric entries keyed only by metric name', () => {
    const entries = buildMetricExplorerEntries({
      series: [
        { __name__: 'node_load15', instance: 'gpu-node001:9100' },
        { __name__: 'node_load15', instance: 'gpu-node002:9100' },
        { __name__: 'custom_metric', instance: 'gpu-node001:9100', device: 'eth0' },
        { __name__: 'DCGM_FI_DEV_GPU_UTIL', instance: 'gpu-node001:9400', 'host.name': 'gpu-node001', gpu: '0' },
      ],
    });

    expect(entries.map((entry) => entry.key)).toEqual([
      buildRawMetricKey('custom_metric'),
      buildRawMetricKey('DCGM_FI_DEV_GPU_UTIL'),
      buildRawMetricKey('node_load15'),
    ]);
    expect(entries[0]).toMatchObject({
      title: 'custom_metric',
      legendFormat: '{{instance}} {{device}}',
    });
    expect(entries[1]).toMatchObject({
      title: 'DCGM_FI_DEV_GPU_UTIL',
      legendFormat: '{{instance}} / GPU {{gpu}}',
    });
    expect(entries[2]).toMatchObject({
      title: 'node_load15',
      legendFormat: '{{instance}}',
    });
  });

  it('discovers job-related metrics via a single series matcher', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-11T03:55:00.000Z'));

    const querySeries = jest
      .fn<Promise<Array<Record<string, string>>>, [{ datasourceUid: string; matcher: string; from: string; to: string }]>()
      .mockResolvedValueOnce([
        { __name__: 'node_load15', instance: 'gpu-node001:9100' },
        { __name__: 'DCGM_FI_DEV_GPU_UTIL', instance: 'gpu-node001:9400', gpu: '0' },
      ]);

    const entries = await discoverJobMetrics({
      job,
      cluster,
      timeRange: { from: '2023-11-14T22:13:20.000Z', to: 'now' },
      querySeries,
    });

    expect(querySeries).toHaveBeenCalledTimes(1);
    expect(querySeries).toHaveBeenCalledWith({
      datasourceUid: 'prom-main',
      matcher: '{instance=~"(gpu-node001):[0-9]+",cluster="slurm-a100"}',
      from: '2023-11-14T22:13:20.000Z',
      to: '2026-03-11T03:55:00.000Z',
    });
    expect(entries.map((entry) => entry.key)).toEqual([
      'raw:DCGM_FI_DEV_GPU_UTIL',
      'raw:node_load15',
    ]);

    jest.useRealTimers();
  });

  it('queries Prometheus series through datasource proxy GET requests', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-11T03:55:00.000Z'));

    mockBackendGet.mockResolvedValueOnce({
      data: [
        { __name__: 'node_load15', instance: 'gpu-node001:9100' },
        { __name__: 'DCGM_FI_DEV_GPU_UTIL', instance: 'gpu-node001:9400', gpu: '0' },
      ],
    });

    await discoverJobMetrics({
      job,
      cluster,
      timeRange: { from: '2023-11-14T22:13:20.000Z', to: 'now' },
    });

    expect(mockBackendGet).toHaveBeenCalledWith('/api/datasources/proxy/uid/prom-main/api/v1/series', {
      'match[]': '{instance=~"(gpu-node001):[0-9]+",cluster="slurm-a100"}',
      start: '2023-11-14T22:13:20.000Z',
      end: '2026-03-11T03:55:00.000Z',
    });
    expect(mockBackendPost).not.toHaveBeenCalled();

    jest.useRealTimers();
  });

  it('falls back to instant query based discovery when the series endpoint returns 422', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-11T03:55:00.000Z'));

    const querySeries = jest
      .fn<Promise<Array<Record<string, string>>>, [{ datasourceUid: string; matcher: string; from: string; to: string }]>()
      .mockRejectedValue({ status: 422 });
    const queryInstant = jest
      .fn<
        Promise<Array<Record<string, string>>>,
        [{ probe: string; datasourceUid: string; expr: string; time: string }]
      >()
      .mockResolvedValueOnce([
        { __name__: 'node_load15', instance: 'gpu-node001:9100' },
        { __name__: 'DCGM_FI_DEV_GPU_UTIL', 'host.name': 'gpu-node001', gpu: '0' },
      ]);

    const entries = await discoverJobMetrics({
      job,
      cluster,
      timeRange: { from: '2023-11-14T22:13:20.000Z', to: 'now' },
      querySeries,
      queryInstant,
    });

    expect(querySeries).toHaveBeenCalledTimes(1);
    expect(queryInstant).toHaveBeenNthCalledWith(1, {
      probe: 'count_by_selector',
      datasourceUid: 'prom-main',
      expr: 'count by(__name__,instance,gpu,device,"host.name") ({instance=~"(gpu-node001):[0-9]+",cluster="slurm-a100"})',
      time: '2026-03-11T03:55:00.000Z',
    });
    expect(entries.map((entry) => entry.key)).toEqual([
      'raw:DCGM_FI_DEV_GPU_UTIL',
      'raw:node_load15',
    ]);

    jest.useRealTimers();
  });

  it('enriches entries with metric type from metadata API', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-11T03:55:00.000Z'));

    const querySeries = jest
      .fn<Promise<Array<Record<string, string>>>, [{ datasourceUid: string; matcher: string; from: string; to: string }]>()
      .mockResolvedValueOnce([
        { __name__: 'node_network_receive_bytes_total', instance: 'gpu-node001:9100', device: 'eth0' },
        { __name__: 'DCGM_FI_DEV_GPU_UTIL', instance: 'gpu-node001:9400', gpu: '0' },
      ]);

    const queryMetadata = jest.fn<Promise<Map<string, PrometheusMetricType>>, [{ datasourceUid: string }]>().mockResolvedValueOnce(
      new Map<string, PrometheusMetricType>([
        ['node_network_receive_bytes_total', 'counter'],
        ['DCGM_FI_DEV_GPU_UTIL', 'gauge'],
      ])
    );

    const entries = await discoverJobMetrics({
      job,
      cluster,
      timeRange: { from: '2023-11-14T22:13:20.000Z', to: 'now' },
      querySeries,
      queryMetadata,
    });

    expect(queryMetadata).toHaveBeenCalledWith({ datasourceUid: 'prom-main' });
    expect(entries.find((e) => e.metricName === 'node_network_receive_bytes_total')?.metricType).toBe('counter');
    expect(entries.find((e) => e.metricName === 'DCGM_FI_DEV_GPU_UTIL')?.metricType).toBe('gauge');

    jest.useRealTimers();
  });

  it('falls back to naming convention when metadata API fails', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-11T03:55:00.000Z'));

    const querySeries = jest
      .fn<Promise<Array<Record<string, string>>>, [{ datasourceUid: string; matcher: string; from: string; to: string }]>()
      .mockResolvedValueOnce([
        { __name__: 'node_network_receive_bytes_total', instance: 'gpu-node001:9100', device: 'eth0' },
        { __name__: 'node_load15', instance: 'gpu-node001:9100' },
      ]);

    const queryMetadata = jest.fn().mockRejectedValueOnce(new Error('metadata unavailable'));

    const entries = await discoverJobMetrics({
      job,
      cluster,
      timeRange: { from: '2023-11-14T22:13:20.000Z', to: 'now' },
      querySeries,
      queryMetadata,
    });

    expect(entries.find((e) => e.metricName === 'node_network_receive_bytes_total')?.metricType).toBe('counter');
    expect(entries.find((e) => e.metricName === 'node_load15')?.metricType).toBe('unknown');

    jest.useRealTimers();
  });

  it('returns a diagnostic error message and logs query context when fallback discovery also fails', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-11T03:55:00.000Z'));

    const errorSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const querySeries = jest
      .fn<Promise<Array<Record<string, string>>>, [{ datasourceUid: string; matcher: string; from: string; to: string }]>()
      .mockRejectedValue({ status: 422, data: { error: 'series parse error' } });
    const queryInstant = jest
      .fn<Promise<Array<Record<string, string>>>, [{ probe: string; datasourceUid: string; expr: string; time: string }]>()
      .mockRejectedValue({ status: 422, data: { error: 'instant parse error' } });

    await expect(
      discoverJobMetrics({
        job,
        cluster,
        timeRange: { from: '2023-11-14T22:13:20.000Z', to: 'now' },
        querySeries,
        queryInstant,
      })
    ).rejects.toThrow('Failed to discover job metrics (HTTP 422). Check browser console for [MetricDiscovery] details.');

    expect(errorSpy).toHaveBeenCalledWith(
      '[MetricDiscovery]',
      'All fallback discovery probes failed',
      expect.objectContaining({
        clusterId: 'a100',
        jobId: 10001,
        nodeCount: 2,
        metricsType: 'prometheus',
        instanceLabel: 'instance',
        aggregationNodeLabels: ['host.name', 'instance'],
        seriesQuery: expect.any(Object),
        fallbackQueries: expect.any(Array),
        fallbackFailures: expect.any(Array),
        errorStatus: 422,
        errorData: { error: 'instant parse error' },
      })
    );
    errorSpy.mockRestore();
    jest.useRealTimers();
  });
});
