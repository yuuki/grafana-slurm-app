import { of } from 'rxjs';

const mockFetch = jest.fn();

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({ fetch: mockFetch }),
}));

import { fetchJobsUtilizationBatch } from './jobMetrics';
import { ClusterSummary, JobRecord } from '../../api/types';

const baseCluster: ClusterSummary = {
  id: 'a100',
  displayName: 'A100',
  slurmClusterName: 'slurm-a100',
  metricsDatasourceUid: 'prom-main',
  metricsType: 'prometheus',
  aggregationNodeLabels: ['instance'],
  instanceLabel: 'instance',
  nodeMatcherMode: 'host:port',
  defaultTemplateId: 'overview',
  metricsFilterLabel: 'cluster',
  metricsFilterValue: 'slurm-a100',
};

const baseJob: JobRecord = {
  clusterId: 'a100',
  jobId: 10001,
  name: 'train',
  user: 'researcher1',
  account: 'ml-team',
  partition: 'gpu-a100',
  state: 'RUNNING',
  nodes: ['gpu-node001', 'gpu-node002'],
  nodeList: 'gpu-node[001-002]',
  nodeCount: 2,
  gpusTotal: 8,
  submitTime: 1700000000,
  startTime: 1700000100,
  endTime: 0,
  exitCode: 0,
  workDir: '/tmp',
  tres: 'gres/gpu=8',
  templateId: 'overview',
};

function makeVectorResponse(items: Array<{ instance: string; value: string }>, instanceLabel = 'instance') {
  return of({
    data: {
      data: {
        result: items.map(({ instance, value }) => ({
          metric: { [instanceLabel]: instance },
          value: [1700000000, value],
        })),
      },
    },
  });
}

/** Extract the query string from a fetch call's data (URLSearchParams-encoded). */
function getQueryFromCall(callIndex: number): string {
  const opts = mockFetch.mock.calls[callIndex][0];
  const params = new URLSearchParams(opts.data);
  return params.get('query') ?? '';
}

describe('fetchJobsUtilizationBatch', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('makes 2 batch queries for cluster with GPU jobs and returns per-job averages', async () => {
    mockFetch
      .mockReturnValueOnce(
        makeVectorResponse([
          { instance: 'gpu-node001:9100', value: '62.5' },
          { instance: 'gpu-node002:9100', value: '80.0' },
        ])
      )
      .mockReturnValueOnce(
        makeVectorResponse([
          { instance: 'gpu-node001:9100', value: '75.0' },
          { instance: 'gpu-node002:9100', value: '90.0' },
        ])
      );

    const result = await fetchJobsUtilizationBatch([baseJob], baseCluster);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const util = result.get('a100-10001');
    // CPU: avg(62.5, 80.0) = 71.25
    expect(util?.cpuPercent).toBeCloseTo(71.25);
    // GPU: avg(75.0, 90.0) = 82.5
    expect(util?.gpuPercent).toBeCloseTo(82.5);
  });

  it('makes only 1 query when no job has GPUs', async () => {
    const nonGpuJob = { ...baseJob, gpusTotal: 0 };
    mockFetch.mockReturnValueOnce(
      makeVectorResponse([{ instance: 'gpu-node001:9100', value: '50.0' }])
    );

    await fetchJobsUtilizationBatch([nonGpuJob], baseCluster);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('skips completed jobs (endTime > 0) and returns empty map', async () => {
    const completedJob = { ...baseJob, endTime: 1700003600 };

    const result = await fetchJobsUtilizationBatch([completedJob], baseCluster);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });

  it('covers all running job nodes in a single matcher', async () => {
    const job2: JobRecord = {
      ...baseJob,
      jobId: 10002,
      nodes: ['gpu-node003'],
    };
    mockFetch
      .mockReturnValueOnce(makeVectorResponse([]))
      .mockReturnValueOnce(makeVectorResponse([]));

    await fetchJobsUtilizationBatch([baseJob, job2], baseCluster);

    const cpuQuery = getQueryFromCall(0);
    expect(cpuQuery).toContain('gpu-node001');
    expect(cpuQuery).toContain('gpu-node003');
  });

  it('returns empty map when cluster has no datasource UID', async () => {
    const cluster = { ...baseCluster, metricsDatasourceUid: '' };

    const result = await fetchJobsUtilizationBatch([baseJob], cluster);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });

  it('returns empty cpuPercent for a job whose nodes have no matching instance data', async () => {
    mockFetch
      .mockReturnValueOnce(makeVectorResponse([{ instance: 'other-node:9100', value: '50.0' }]))
      .mockReturnValueOnce(makeVectorResponse([]));

    const result = await fetchJobsUtilizationBatch([baseJob], baseCluster);

    const util = result.get('a100-10001');
    expect(util?.cpuPercent).toBeUndefined();
  });

  it('uses custom cpuUtilizationExpr when provided', async () => {
    const customCluster = {
      ...baseCluster,
      cpuUtilizationExpr: 'max by(${formattedLabel}) (custom_cpu_metric{${matcher}})',
    };
    mockFetch
      .mockReturnValueOnce(
        makeVectorResponse([{ instance: 'gpu-node001:9100', value: '55.0' }])
      )
      .mockReturnValueOnce(makeVectorResponse([]));

    await fetchJobsUtilizationBatch([baseJob], customCluster);

    const cpuQuery = getQueryFromCall(0);
    expect(cpuQuery).toContain('custom_cpu_metric');
    expect(cpuQuery).toContain('max by(');
    expect(cpuQuery).not.toContain('node_cpu_seconds_total');
  });

  it('uses custom gpuUtilizationExpr when provided', async () => {
    const customCluster = {
      ...baseCluster,
      gpuUtilizationExpr: 'avg by(${formattedLabel}) (custom_gpu_metric{${matcher}}) / 100',
    };
    mockFetch
      .mockReturnValueOnce(makeVectorResponse([]))
      .mockReturnValueOnce(
        makeVectorResponse([{ instance: 'gpu-node001:9100', value: '0.8' }])
      );

    await fetchJobsUtilizationBatch([baseJob], customCluster);

    const gpuQuery = getQueryFromCall(1);
    expect(gpuQuery).toContain('custom_gpu_metric');
    expect(gpuQuery).toContain('/ 100');
    expect(gpuQuery).not.toContain('DCGM_FI_DEV_GPU_UTIL');
  });

  it('falls back to default expressions when utilization fields are empty', async () => {
    const clusterWithEmpty = { ...baseCluster, cpuUtilizationExpr: '', gpuUtilizationExpr: '' };
    mockFetch
      .mockReturnValueOnce(makeVectorResponse([]))
      .mockReturnValueOnce(makeVectorResponse([]));

    await fetchJobsUtilizationBatch([baseJob], clusterWithEmpty);

    const cpuQuery = getQueryFromCall(0);
    expect(cpuQuery).toContain('node_cpu_seconds_total');
    const gpuQuery = getQueryFromCall(1);
    expect(gpuQuery).toContain('DCGM_FI_DEV_GPU_UTIL');
  });

  it('sends POST with application/x-www-form-urlencoded content type', async () => {
    mockFetch
      .mockReturnValueOnce(makeVectorResponse([]))
      .mockReturnValueOnce(makeVectorResponse([]));

    await fetchJobsUtilizationBatch([baseJob], baseCluster);

    const opts = mockFetch.mock.calls[0][0];
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('handles many nodes in a single POST query without URL length issues', async () => {
    const manyNodes = Array.from({ length: 100 }, (_, i) => `gpu-node${String(i + 1).padStart(3, '0')}`);
    const bigJob: JobRecord = {
      ...baseJob,
      jobId: 20001,
      nodes: manyNodes,
      gpusTotal: 8,
    };

    mockFetch
      .mockReturnValueOnce(makeVectorResponse(
        manyNodes.map((node) => ({ instance: `${node}:9100`, value: '60.0' }))
      ))
      .mockReturnValueOnce(makeVectorResponse(
        manyNodes.map((node) => ({ instance: `${node}:9100`, value: '80.0' }))
      ));

    const result = await fetchJobsUtilizationBatch([bigJob], baseCluster);

    // POST body carries the query, so 100 nodes still results in only 2 queries (CPU + GPU)
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const util = result.get('a100-20001');
    expect(util?.cpuPercent).toBeCloseTo(60.0);
    expect(util?.gpuPercent).toBeCloseTo(80.0);
  });
});
