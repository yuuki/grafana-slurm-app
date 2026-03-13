import { ClusterSummary, JobRecord } from '../../../api/types';
import { collectMetricAutoFilterInput } from './metricAutoFilter';

describe('metric auto filter', () => {
  const cluster: ClusterSummary = {
    id: 'a100',
    displayName: 'A100 Cluster',
    slurmClusterName: 'slurm-a100',
    metricsDatasourceUid: 'prom-main',
    metricsType: 'prometheus',
    instanceLabel: 'instance',
    nodeMatcherMode: 'host:port',
    defaultTemplateId: 'distributed-training',
    metricsFilterLabel: 'cluster',
    metricsFilterValue: 'slurm-a100',
    aggregationNodeLabels: ['host.name', 'instance'],
  };

  const job: JobRecord = {
    clusterId: 'a100',
    jobId: 10001,
    name: 'train_llm',
    user: 'researcher1',
    account: 'ml-team',
    partition: 'gpu-a100',
    state: 'RUNNING',
    nodes: ['gpu-node001'],
    nodeCount: 1,
    gpusTotal: 8,
    startTime: 1700000000,
    endTime: 0,
    exitCode: 0,
    workDir: '/tmp',
    tres: '1001=gres/gpu:8',
    templateId: 'distributed-training',
  };

  it('collects datasource query_range results into an auto-filter payload', async () => {
    const queryRange = jest.fn().mockResolvedValueOnce([
      {
        metric: { __name__: 'node_load15', instance: 'gpu-node001:9100' },
        values: [
          [1700000000, '1.5'],
          [1700000060, '2.5'],
        ],
      },
      {
        metric: { __name__: 'DCGM_FI_DEV_GPU_UTIL', instance: 'gpu-node001:9400', gpu: '0' },
        values: [
          [1700000000, '20'],
          [1700000060, '40'],
        ],
      },
    ]);

    const payload = await collectMetricAutoFilterInput({
      cluster,
      job,
      rawEntries: [
        {
          kind: 'raw',
          key: 'raw:node_load15',
          title: 'node_load15',
          description: '',
          legendFormat: '{{instance}}',
          fieldConfig: { defaults: {}, overrides: [] },
          metricName: 'node_load15',
          labelKeys: ['instance'],
        },
        {
          kind: 'raw',
          key: 'raw:DCGM_FI_DEV_GPU_UTIL',
          title: 'DCGM_FI_DEV_GPU_UTIL',
          description: '',
          legendFormat: '{{instance}} / GPU {{gpu}}',
          fieldConfig: { defaults: {}, overrides: [] },
          metricName: 'DCGM_FI_DEV_GPU_UTIL',
          labelKeys: ['instance', 'gpu'],
        },
      ],
      timeRange: {
        from: '2023-11-14T22:13:20.000Z',
        to: '2023-11-14T22:14:20.000Z',
      },
      queryRange,
    });

    expect(queryRange).toHaveBeenCalledWith({
      datasourceUid: 'prom-main',
      query: '{__name__=~"DCGM_FI_DEV_GPU_UTIL|node_load15",instance=~"(gpu-node001):[0-9]+",cluster="slurm-a100"}',
      from: '2023-11-14T22:13:20.000Z',
      to: '2023-11-14T22:14:20.000Z',
      step: '15s',
    });
    expect(payload.timestamps).toEqual([1700000000000, 1700000060000]);
    expect(payload.series).toEqual([
      {
        seriesId: 'raw:node_load15',
        metricKey: 'raw:node_load15',
        metricName: 'node_load15',
        values: [1.5, 2.5],
      },
      {
        seriesId: 'raw:DCGM_FI_DEV_GPU_UTIL',
        metricKey: 'raw:DCGM_FI_DEV_GPU_UTIL',
        metricName: 'DCGM_FI_DEV_GPU_UTIL',
        values: [20, 40],
      },
    ]);
  });

  it('fills missing timestamps with null to keep the matrix aligned', async () => {
    const queryRange = jest.fn().mockResolvedValueOnce([
      {
        metric: { __name__: 'node_load15', instance: 'gpu-node001:9100' },
        values: [
          [1700000000, '1.5'],
          [1700000120, '3.5'],
        ],
      },
    ]);

    const payload = await collectMetricAutoFilterInput({
      cluster,
      job,
      rawEntries: [
        {
          kind: 'raw',
          key: 'raw:node_load15',
          title: 'node_load15',
          description: '',
          legendFormat: '{{instance}}',
          fieldConfig: { defaults: {}, overrides: [] },
          metricName: 'node_load15',
          labelKeys: ['instance'],
        },
      ],
      timeRange: {
        from: '2023-11-14T22:13:20.000Z',
        to: '2023-11-14T22:15:20.000Z',
      },
      queryRange,
    });

    expect(payload.timestamps).toEqual([1700000000000, 1700000120000]);
    expect(payload.series[0].values).toEqual([1.5, 3.5]);
  });

  it('splits large metric sets into multiple query_range requests', async () => {
    const rawEntries = Array.from({ length: 250 }, (_, index) => {
      const metricName = `node_metric_${String(index).padStart(3, '0')}`;
      return {
        kind: 'raw' as const,
        key: `raw:${metricName}`,
        title: metricName,
        description: '',
        legendFormat: '{{instance}}',
        fieldConfig: { defaults: {}, overrides: [] },
        metricName,
        labelKeys: ['instance'],
      };
    });
    const queryRange = jest.fn().mockImplementation(async ({ query }: { query: string }) => {
      const metricMatcher = query.match(/__name__=~"([^"]+)"/)?.[1] ?? '';
      const metricNames = metricMatcher.split('|').filter(Boolean);

      return metricNames.map((metricName) => ({
        metric: { __name__: metricName, instance: 'gpu-node001:9100' },
        values: [[1700000000, '1']],
      }));
    });

    const payload = await collectMetricAutoFilterInput({
      cluster,
      job,
      rawEntries,
      timeRange: {
        from: '2023-11-14T22:13:20.000Z',
        to: '2023-11-14T22:14:20.000Z',
      },
      queryRange,
    });

    expect(queryRange.mock.calls.length).toBeGreaterThan(1);
    expect(payload.series).toHaveLength(250);
    expect(payload.timestamps).toEqual([1700000000000]);
  });

  it('aggregates multiple label series for the same metric key into one payload series', async () => {
    const queryRange = jest.fn().mockResolvedValueOnce([
      {
        metric: { __name__: 'DCGM_FI_DEV_GPU_UTIL', instance: 'gpu-node001:9400', gpu: '0' },
        values: [
          [1700000000, '20'],
          [1700000060, '40'],
        ],
      },
      {
        metric: { __name__: 'DCGM_FI_DEV_GPU_UTIL', instance: 'gpu-node001:9400', gpu: '1' },
        values: [
          [1700000000, '40'],
          [1700000060, '60'],
        ],
      },
    ]);

    const payload = await collectMetricAutoFilterInput({
      cluster,
      job,
      rawEntries: [
        {
          kind: 'raw',
          key: 'raw:DCGM_FI_DEV_GPU_UTIL',
          title: 'DCGM_FI_DEV_GPU_UTIL',
          description: '',
          legendFormat: '{{instance}} / GPU {{gpu}}',
          fieldConfig: { defaults: {}, overrides: [] },
          metricName: 'DCGM_FI_DEV_GPU_UTIL',
          labelKeys: ['instance', 'gpu'],
        },
      ],
      timeRange: {
        from: '2023-11-14T22:13:20.000Z',
        to: '2023-11-14T22:14:20.000Z',
      },
      queryRange,
    });

    expect(payload.series).toEqual([
      {
        seriesId: 'raw:DCGM_FI_DEV_GPU_UTIL',
        metricKey: 'raw:DCGM_FI_DEV_GPU_UTIL',
        metricName: 'DCGM_FI_DEV_GPU_UTIL',
        values: [30, 50],
      },
    ]);
  });

  it('uses a coarse query step for running jobs when the time range ends at now', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-12T12:00:00.000Z'));
    const queryRange = jest.fn().mockResolvedValueOnce([
      {
        metric: { __name__: 'node_load15', instance: 'gpu-node001:9100' },
        values: [[1700000000, '1.5']],
      },
    ]);

    await collectMetricAutoFilterInput({
      cluster,
      job,
      rawEntries: [
        {
          kind: 'raw',
          key: 'raw:node_load15',
          title: 'node_load15',
          description: '',
          legendFormat: '{{instance}}',
          fieldConfig: { defaults: {}, overrides: [] },
          metricName: 'node_load15',
          labelKeys: ['instance'],
        },
      ],
      timeRange: {
        from: '2026-03-10T12:00:00.000Z',
        to: 'now',
      },
      queryRange,
    });

    expect(queryRange).toHaveBeenCalledWith(
      expect.objectContaining({
        step: '1440s',
      })
    );
    jest.useRealTimers();
  });
});
