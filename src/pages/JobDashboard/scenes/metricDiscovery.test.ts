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
    aggregationNodeLabels: ['host.name', 'instance'],
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
        { __name__: 'DCGM_FI_DEV_GPU_UTIL', instance: 'gpu-node001:9400', 'host.name': 'gpu-node001', gpu: '0' },
        { __name__: 'DCGM_FI_DEV_GPU_UTIL', instance: 'gpu-node001:9400', 'host.name': 'gpu-node001', gpu: '1' },
      ],
      aggregationNodeLabels: cluster.aggregationNodeLabels,
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
      aggregationEligible: true,
      aggregationLabel: 'host.name',
      aggregatedLegendFormat: '{{host.name}}',
    });
    expect(entries[1]).toMatchObject({
      kind: 'raw',
      matcherKind: 'node',
      title: 'Load Average (15m)',
      legendFormat: '{{instance}}',
      aggregationEligible: false,
    });
    expect(entries[2]).toMatchObject({
      kind: 'raw',
      matcherKind: 'node',
      title: 'custom_metric',
      legendFormat: '{{instance}} {{device}}',
      aggregationEligible: false,
    });
  });

  it('falls back to raw display when no configured aggregation label is present on a gpu metric', () => {
    const entries = buildMetricExplorerEntries({
      nodeSeries: [],
      gpuSeries: [{ __name__: 'DCGM_FI_DEV_GPU_UTIL', exported_instance: 'gpu-node001', gpu: '0' }],
      aggregationNodeLabels: ['host.name', 'instance'],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      key: buildRawMetricKey('gpu', 'DCGM_FI_DEV_GPU_UTIL'),
      aggregationEligible: false,
      aggregationLabel: undefined,
      aggregatedLegendFormat: '{{instance}} / GPU {{gpu}}',
    });
  });

  it('normalizes configured aggregation label names before resolving discovered series labels', () => {
    const entries = buildMetricExplorerEntries({
      nodeSeries: [],
      gpuSeries: [{ __name__: 'DCGM_FI_DEV_GPU_UTIL', 'host.name': 'gpu-node001', gpu: '0' }],
      aggregationNodeLabels: ['host.name', 'instance'],
    });

    expect(entries[0]).toMatchObject({
      aggregationEligible: true,
      aggregationLabel: 'host.name',
      aggregatedLegendFormat: '{{host.name}}',
    });
  });

  it('deduplicates overlapping node and gpu discovery results by preferring gpu classification for DCGM metrics', () => {
    const entries = buildMetricExplorerEntries({
      nodeSeries: [{ __name__: 'DCGM_FI_DEV_APP_MEM_CLOCK', 'host.name': 'gpu-node001', gpu: '0' }],
      gpuSeries: [{ __name__: 'DCGM_FI_DEV_APP_MEM_CLOCK', 'host.name': 'gpu-node001', gpu: '0' }],
      aggregationNodeLabels: ['host.name', 'instance'],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      key: buildRawMetricKey('gpu', 'DCGM_FI_DEV_APP_MEM_CLOCK'),
      matcherKind: 'gpu',
      aggregationEligible: true,
      aggregationLabel: 'host.name',
    });
  });

  it('discovers job-related metrics via node and gpu series matchers', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-11T03:55:00.000Z'));

    const querySeries = jest
      .fn<Promise<Array<Record<string, string>>>, [{ datasourceUid: string; matcher: string; from: string; to: string }]>()
      .mockResolvedValueOnce([{ __name__: 'node_load15', instance: 'gpu-node001:9100' }])
      .mockResolvedValueOnce([{ __name__: 'DCGM_FI_DEV_GPU_UTIL', instance: 'gpu-node001:9400', gpu: '0' }]);

    const entries = await discoverJobMetrics({
      job,
      cluster,
      timeRange: { from: '2023-11-14T22:13:20.000Z', to: 'now' },
      querySeries,
    });

    expect(querySeries).toHaveBeenNthCalledWith(1, {
      target: 'node',
      datasourceUid: 'prom-main',
      matcher: '{instance="gpu-node001:9100",cluster="slurm-a100"}',
      from: '2023-11-14T22:13:20.000Z',
      to: '2026-03-11T03:55:00.000Z',
    });
    expect(querySeries).toHaveBeenNthCalledWith(2, {
      target: 'gpu',
      datasourceUid: 'prom-main',
      matcher: '{instance="gpu-node001:9400",cluster="slurm-a100"}',
      from: '2023-11-14T22:13:20.000Z',
      to: '2026-03-11T03:55:00.000Z',
    });
    expect(entries.map((entry) => entry.key)).toEqual([
      'raw:gpu:DCGM_FI_DEV_GPU_UTIL',
      'raw:node:node_load15',
    ]);

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
      'match[]': '{instance="gpu-node001:9100",cluster="slurm-a100"}',
      start: '2023-11-14T22:13:20.000Z',
      end: '2026-03-11T03:55:00.000Z',
    });
    expect(mockBackendGet).toHaveBeenNthCalledWith(2, '/api/datasources/proxy/uid/prom-main/api/v1/series', {
      'match[]': '{instance="gpu-node001:9400",cluster="slurm-a100"}',
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
        [{ target: 'node' | 'gpu'; probe: string; datasourceUid: string; expr: string; time: string }]
      >()
      .mockResolvedValueOnce([{ __name__: 'node_load15', instance: 'gpu-node001:9100' }])
      .mockResolvedValueOnce([{ __name__: 'DCGM_FI_DEV_GPU_UTIL', 'host.name': 'gpu-node001', gpu: '0' }]);

    const entries = await discoverJobMetrics({
      job,
      cluster,
      timeRange: { from: '2023-11-14T22:13:20.000Z', to: 'now' },
      querySeries,
      queryInstant,
    });

    expect(querySeries).toHaveBeenCalledTimes(2);
    expect(queryInstant).toHaveBeenNthCalledWith(1, {
      target: 'node',
      probe: 'count_by_selector',
      datasourceUid: 'prom-main',
      expr: 'count by(__name__,instance,gpu,device,"host.name") ({instance="gpu-node001:9100",cluster="slurm-a100"})',
      time: '2026-03-11T03:55:00.000Z',
    });
    expect(queryInstant).toHaveBeenNthCalledWith(2, {
      target: 'gpu',
      probe: 'count_by_selector',
      datasourceUid: 'prom-main',
      expr: 'count by(__name__,instance,gpu,device,"host.name") ({instance="gpu-node001:9400",cluster="slurm-a100"})',
      time: '2026-03-11T03:55:00.000Z',
    });
    expect(entries.map((entry) => entry.key)).toEqual([
      'raw:gpu:DCGM_FI_DEV_GPU_UTIL',
      'raw:node:node_load15',
    ]);

    jest.useRealTimers();
  });

  it('uses bare dotted labels for VictoriaMetrics discovery queries', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-11T03:55:00.000Z'));

    const querySeries = jest
      .fn<Promise<Array<Record<string, string>>>, [{ datasourceUid: string; matcher: string; from: string; to: string }]>()
      .mockRejectedValue({ status: 422 });
    const queryInstant = jest
      .fn<
        Promise<Array<Record<string, string>>>,
        [{ target: 'node' | 'gpu'; probe: string; datasourceUid: string; expr: string; time: string }]
      >()
      .mockResolvedValueOnce([{ __name__: 'node_load15', 'host.name': 'gpu-node001' }])
      .mockResolvedValueOnce([{ __name__: 'DCGM_FI_DEV_GPU_UTIL', 'host.name': 'gpu-node001', gpu: '0' }]);

    await discoverJobMetrics({
      job,
      cluster: {
        ...cluster,
        metricsType: 'victoriametrics',
        instanceLabel: 'host.name',
        metricsFilterLabel: 'k8s.cluster.name',
      },
      timeRange: { from: '2023-11-14T22:13:20.000Z', to: 'now' },
      querySeries,
      queryInstant,
    });

    expect(querySeries).toHaveBeenNthCalledWith(1, {
      target: 'node',
      datasourceUid: 'prom-main',
      matcher: '{host.name="gpu-node001:9100",k8s.cluster.name="slurm-a100"}',
      from: '2023-11-14T22:13:20.000Z',
      to: '2026-03-11T03:55:00.000Z',
    });
    expect(queryInstant).toHaveBeenNthCalledWith(1, {
      target: 'node',
      probe: 'count_by_selector',
      datasourceUid: 'prom-main',
      expr: 'count by(__name__,instance,gpu,device,host.name) ({host.name="gpu-node001:9100",k8s.cluster.name="slurm-a100"})',
      time: '2026-03-11T03:55:00.000Z',
    });

    jest.useRealTimers();
  });

  it('returns a diagnostic error message and logs query context when fallback discovery also fails', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-11T03:55:00.000Z'));

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const querySeries = jest
      .fn<Promise<Array<Record<string, string>>>, [{ datasourceUid: string; matcher: string; from: string; to: string }]>()
      .mockRejectedValue({ status: 422, data: { error: 'series parse error' } });
    const queryInstant = jest
      .fn<
        Promise<Array<Record<string, string>>>,
        [{ target: 'node' | 'gpu'; probe: string; datasourceUid: string; expr: string; time: string }]
      >()
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
        seriesQueries: expect.any(Array),
        fallbackQueries: expect.any(Array),
        fallbackFailures: expect.any(Array),
        errorStatus: 422,
        errorData: { error: 'instant parse error' },
      })
    );
    errorSpy.mockRestore();
    jest.useRealTimers();
  });

  it('tries multiple fallback probes in order and succeeds on the second probe', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-11T03:55:00.000Z'));

    const querySeries = jest
      .fn<Promise<Array<Record<string, string>>>, [{ datasourceUid: string; matcher: string; from: string; to: string }]>()
      .mockRejectedValue({ status: 422 });
    const queryInstant = jest
      .fn<
        Promise<Array<Record<string, string>>>,
        [{ target: 'node' | 'gpu'; probe: string; datasourceUid: string; expr: string; time: string }]
      >((args) => {
        if (args.probe === 'count_by_selector') {
          return Promise.reject({ status: 422, data: { error: 'count by selector parse error' } });
        }
        if (args.target === 'node' && args.probe === 'count_by_last_over_time') {
          return Promise.resolve([{ __name__: 'node_load15', instance: 'gpu-node001:9100' }]);
        }
        if (args.target === 'gpu' && args.probe === 'count_by_last_over_time') {
          return Promise.resolve([{ __name__: 'DCGM_FI_DEV_GPU_UTIL', instance: 'gpu-node001:9400', gpu: '0' }]);
        }
        return Promise.reject({ status: 422, data: { error: 'unexpected probe' } });
      });

    const entries = await discoverJobMetrics({
      job,
      cluster,
      timeRange: { from: '2023-11-14T22:13:20.000Z', to: 'now' },
      querySeries,
      queryInstant,
    });

    expect(queryInstant.mock.calls.map(([args]) => ({ target: args.target, probe: args.probe }))).toEqual([
      { target: 'node', probe: 'count_by_selector' },
      { target: 'gpu', probe: 'count_by_selector' },
      { target: 'node', probe: 'count_by_last_over_time' },
      { target: 'gpu', probe: 'count_by_last_over_time' },
    ]);
    expect(entries.map((entry) => entry.key)).toEqual([
      'raw:gpu:DCGM_FI_DEV_GPU_UTIL',
      'raw:node:node_load15',
    ]);

    jest.useRealTimers();
  });
});
