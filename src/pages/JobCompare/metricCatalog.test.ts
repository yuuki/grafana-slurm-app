const mockGet = jest.fn();

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({ get: mockGet }),
}));

import { ClusterSummary } from '../../api/types';
import {
  buildCompareMetricEntry,
  buildMetricOptions,
  fetchMetricTypes,
  isGpuMetric,
  listMetricNames,
  resolveMetricType,
} from './metricCatalog';

const cluster: ClusterSummary = {
  id: 'a100',
  displayName: 'A100',
  slurmClusterName: 'slurm-a100',
  metricsDatasourceUid: 'prom-main',
  metricsType: 'prometheus',
  aggregationNodeLabels: ['instance'],
  instanceLabel: 'instance',
  nodeMatcherMode: 'hostname',
  defaultTemplateId: 'overview',
  metricsFilterLabel: 'cluster',
  metricsFilterValue: 'slurm-a100',
};

describe('metric catalog', () => {
  beforeEach(() => mockGet.mockReset());

  it('lists metric names scoped by the cluster filter and time range', async () => {
    mockGet.mockResolvedValue({ data: ['node_load1', 'DCGM_FI_DEV_GPU_UTIL', 'bad{name}'] });
    const names = await listMetricNames(cluster, { from: 100, to: 200 });
    expect(names).toEqual(['DCGM_FI_DEV_GPU_UTIL', 'node_load1']);
    const url: string = mockGet.mock.calls[0][0];
    expect(url.startsWith('/api/datasources/proxy/uid/prom-main/api/v1/label/__name__/values?')).toBe(true);
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('match[]')).toBe('{cluster="slurm-a100"}');
    expect(params.get('start')).toBe('100');
    expect(params.get('end')).toBe('200');
  });

  it('returns no names without a datasource', async () => {
    expect(await listMetricNames({ ...cluster, metricsDatasourceUid: '' }, { from: 0, to: 1 })).toEqual([]);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('reads metric types from metadata and falls back to the name', async () => {
    mockGet.mockResolvedValue({ data: { node_load1: [{ type: 'gauge' }] } });
    const types = await fetchMetricTypes(cluster);
    expect(resolveMetricType('node_load1', types)).toBe('gauge');
    expect(resolveMetricType('node_network_receive_bytes_total', types)).toBe('counter');
    mockGet.mockRejectedValue(new Error('boom'));
    expect((await fetchMetricTypes(cluster)).size).toBe(0);
  });

  it('groups suggested metrics first', () => {
    expect(buildMetricOptions(['zzz_metric', 'node_load1', 'DCGM_FI_DEV_GPU_UTIL'])).toEqual([
      {
        label: 'Suggested',
        options: [
          { label: 'DCGM_FI_DEV_GPU_UTIL', value: 'DCGM_FI_DEV_GPU_UTIL' },
          { label: 'node_load1', value: 'node_load1' },
        ],
      },
      { label: 'All metrics', options: [{ label: 'zzz_metric', value: 'zzz_metric' }] },
    ]);
  });

  it('detects GPU metrics and builds per-GPU preview entries', () => {
    expect(isGpuMetric('DCGM_FI_PROF_PIPE_TENSOR_ACTIVE')).toBe(true);
    expect(isGpuMetric('node_load1')).toBe(false);
    expect(buildCompareMetricEntry('DCGM_FI_DEV_GPU_UTIL', 'gauge')).toMatchObject({
      metricName: 'DCGM_FI_DEV_GPU_UTIL',
      metricType: 'gauge',
      legendFormat: '{{instance}} / GPU {{gpu}}',
    });
    expect(buildCompareMetricEntry('node_load1', 'gauge').legendFormat).toBe('{{instance}}');
  });
});
