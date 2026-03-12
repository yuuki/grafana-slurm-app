const mockBackendGet = jest.fn();

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({
    get: mockBackendGet,
  }),
}));

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
    nodeExporterPort: '9100',
    dcgmExporterPort: '9400',
    nodeMatcherMode: 'host:port',
    defaultTemplateId: 'distributed-training',
    metricsFilterLabel: 'cluster',
    metricsFilterValue: 'slurm-a100',
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

  beforeEach(() => {
    mockBackendGet.mockReset();
  });

  it('collects datasource query_range results into an auto-filter payload', async () => {
    mockBackendGet
      .mockResolvedValueOnce({
        data: {
          resultType: 'matrix',
          result: [
            {
              metric: { __name__: 'node_load15', instance: 'gpu-node001:9100' },
              values: [
                [1700000000, '1.5'],
                [1700000060, '2.5'],
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          resultType: 'matrix',
          result: [
            {
              metric: { __name__: 'DCGM_FI_DEV_GPU_UTIL', instance: 'gpu-node001:9400', gpu: '0' },
              values: [
                [1700000000, '20'],
                [1700000060, '40'],
              ],
            },
          ],
        },
      });

    const payload = await collectMetricAutoFilterInput({
      cluster,
      job,
      rawEntries: [
        {
          kind: 'raw',
          key: 'raw:node:node_load15',
          matcherKind: 'node',
          title: 'Load Average (15m)',
          description: '',
          legendFormat: '{{instance}}',
          fieldConfig: { defaults: {}, overrides: [] },
          metricName: 'node_load15',
          labelKeys: ['instance'],
        },
        {
          kind: 'raw',
          key: 'raw:gpu:DCGM_FI_DEV_GPU_UTIL',
          matcherKind: 'gpu',
          title: 'GPU Utilization',
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
    });

    expect(mockBackendGet).toHaveBeenNthCalledWith(1, '/api/datasources/proxy/uid/prom-main/api/v1/query_range', {
      query: '{__name__=~"node_load15",instance=~"(gpu-node001):9100",cluster="slurm-a100"}',
      start: '2023-11-14T22:13:20.000Z',
      end: '2023-11-14T22:14:20.000Z',
      step: '15s',
    });
    expect(mockBackendGet).toHaveBeenNthCalledWith(2, '/api/datasources/proxy/uid/prom-main/api/v1/query_range', {
      query: '{__name__=~"DCGM_FI_DEV_GPU_UTIL",instance=~"(gpu-node001):9400",cluster="slurm-a100"}',
      start: '2023-11-14T22:13:20.000Z',
      end: '2023-11-14T22:14:20.000Z',
      step: '15s',
    });
    expect(payload.timestamps).toEqual([1700000000000, 1700000060000]);
    expect(payload.series).toEqual([
      {
        seriesId: 'node:node_load15:instance=gpu-node001:9100',
        metricKey: 'raw:node:node_load15',
        metricName: 'node_load15',
        values: [1.5, 2.5],
      },
      {
        seriesId: 'gpu:DCGM_FI_DEV_GPU_UTIL:gpu=0,instance=gpu-node001:9400',
        metricKey: 'raw:gpu:DCGM_FI_DEV_GPU_UTIL',
        metricName: 'DCGM_FI_DEV_GPU_UTIL',
        values: [20, 40],
      },
    ]);
  });

  it('fills missing timestamps with null to keep the matrix aligned', async () => {
    mockBackendGet
      .mockResolvedValueOnce({
        data: {
          resultType: 'matrix',
          result: [
            {
              metric: { __name__: 'node_load15', instance: 'gpu-node001:9100' },
              values: [
                [1700000000, '1.5'],
                [1700000120, '3.5'],
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          resultType: 'matrix',
          result: [],
        },
      });

    const payload = await collectMetricAutoFilterInput({
      cluster,
      job,
      rawEntries: [
        {
          kind: 'raw',
          key: 'raw:node:node_load15',
          matcherKind: 'node',
          title: 'Load Average (15m)',
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
    });

    expect(payload.timestamps).toEqual([1700000000000, 1700000120000]);
    expect(payload.series[0].values).toEqual([1.5, 3.5]);
  });
});
