const mockGet = jest.fn();

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({ get: mockGet }),
}));

// model.ts はそのまま使う（buildInstanceMatcher, buildFilterMatcher のロジックを実際に動かす）

import { fetchJobUtilization, fetchJobsUtilizationBatch } from './jobMetrics';
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

function makePromResponse(value: string) {
  return { data: { result: [{ value: [1700000000, value] }] } };
}

describe('fetchJobUtilization', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it('fetches CPU and GPU utilization for a GPU job', async () => {
    mockGet
      .mockResolvedValueOnce(makePromResponse('62.5'))  // CPU
      .mockResolvedValueOnce(makePromResponse('80.0'));  // GPU

    const result = await fetchJobUtilization(baseJob, baseCluster);

    expect(result.cpuPercent).toBeCloseTo(62.5);
    expect(result.gpuPercent).toBeCloseTo(80.0);
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('skips GPU query for non-GPU jobs', async () => {
    mockGet.mockResolvedValueOnce(makePromResponse('45.0'));

    const job = { ...baseJob, gpusTotal: 0 };
    const result = await fetchJobUtilization(job, baseCluster);

    expect(result.cpuPercent).toBeCloseTo(45.0);
    expect(result.gpuPercent).toBeUndefined();
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('returns both undefined when job has no nodes', async () => {
    const job = { ...baseJob, nodes: [] };
    const result = await fetchJobUtilization(job, baseCluster);

    expect(result.cpuPercent).toBeUndefined();
    expect(result.gpuPercent).toBeUndefined();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('returns both undefined when cluster has no datasource UID', async () => {
    const cluster = { ...baseCluster, metricsDatasourceUid: '' };
    const result = await fetchJobUtilization(baseJob, cluster);

    expect(result.cpuPercent).toBeUndefined();
    expect(result.gpuPercent).toBeUndefined();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('returns undefined for cpuPercent when Prometheus returns no results', async () => {
    mockGet
      .mockResolvedValueOnce({ data: { result: [] } })     // CPU: empty
      .mockResolvedValueOnce(makePromResponse('80.0'));     // GPU

    const result = await fetchJobUtilization(baseJob, baseCluster);

    expect(result.cpuPercent).toBeUndefined();
    expect(result.gpuPercent).toBeCloseTo(80.0);
  });

  it('returns undefined for cpuPercent when the query throws', async () => {
    mockGet
      .mockRejectedValueOnce(new Error('network error'))   // CPU fails
      .mockResolvedValueOnce(makePromResponse('80.0'));     // GPU

    const result = await fetchJobUtilization(baseJob, baseCluster);

    expect(result.cpuPercent).toBeUndefined();
    expect(result.gpuPercent).toBeCloseTo(80.0);
  });

  it('uses midpoint time for completed jobs', async () => {
    const completedJob = { ...baseJob, startTime: 1700000000, endTime: 1700003600 };
    mockGet
      .mockResolvedValueOnce(makePromResponse('50.0'))
      .mockResolvedValueOnce(makePromResponse('75.0'));

    await fetchJobUtilization(completedJob, baseCluster);

    const expectedTime = String(Math.floor((1700000000 + 1700003600) / 2));
    expect(mockGet).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('/api/v1/query'),
      expect.objectContaining({ time: expectedTime })
    );
  });

  it('builds correct PromQL with instance and filter matchers', async () => {
    mockGet
      .mockResolvedValueOnce(makePromResponse('50.0'))
      .mockResolvedValueOnce(makePromResponse('75.0'));

    await fetchJobUtilization(baseJob, baseCluster);

    const cpuCall = mockGet.mock.calls[0];
    expect(cpuCall[1].query).toContain('node_cpu_seconds_total');
    expect(cpuCall[1].query).toContain('gpu-node001');
    expect(cpuCall[1].query).toContain('cluster="slurm-a100"');

    const gpuCall = mockGet.mock.calls[1];
    expect(gpuCall[1].query).toContain('DCGM_FI_DEV_GPU_UTIL');
    expect(gpuCall[1].query).toContain('gpu-node001');
  });

  it('builds correct PromQL without filter matcher when label is empty', async () => {
    const cluster = { ...baseCluster, metricsFilterLabel: '', metricsFilterValue: '' };
    mockGet
      .mockResolvedValueOnce(makePromResponse('50.0'))
      .mockResolvedValueOnce(makePromResponse('75.0'));

    await fetchJobUtilization(baseJob, cluster);

    const cpuCall = mockGet.mock.calls[0];
    expect(cpuCall[1].query).not.toContain('cluster=');
  });
});

function makeVectorResponse(items: Array<{ instance: string; value: string }>, instanceLabel = 'instance') {
  return {
    data: {
      result: items.map(({ instance, value }) => ({
        metric: { [instanceLabel]: instance },
        value: [1700000000, value],
      })),
    },
  };
}

describe('fetchJobsUtilizationBatch', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it('makes 2 batch queries for cluster with GPU jobs and returns per-job averages', async () => {
    mockGet
      .mockResolvedValueOnce(
        makeVectorResponse([
          { instance: 'gpu-node001:9100', value: '62.5' },
          { instance: 'gpu-node002:9100', value: '80.0' },
        ])
      )
      .mockResolvedValueOnce(
        makeVectorResponse([
          { instance: 'gpu-node001:9100', value: '75.0' },
          { instance: 'gpu-node002:9100', value: '90.0' },
        ])
      );

    const result = await fetchJobsUtilizationBatch([baseJob], baseCluster);

    expect(mockGet).toHaveBeenCalledTimes(2);
    const util = result.get('a100-10001');
    // CPU: avg(62.5, 80.0) = 71.25
    expect(util?.cpuPercent).toBeCloseTo(71.25);
    // GPU: avg(75.0, 90.0) = 82.5
    expect(util?.gpuPercent).toBeCloseTo(82.5);
  });

  it('makes only 1 query when no job has GPUs', async () => {
    const nonGpuJob = { ...baseJob, gpusTotal: 0 };
    mockGet.mockResolvedValueOnce(
      makeVectorResponse([{ instance: 'gpu-node001:9100', value: '50.0' }])
    );

    await fetchJobsUtilizationBatch([nonGpuJob], baseCluster);

    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('skips completed jobs (endTime > 0) and returns empty map', async () => {
    const completedJob = { ...baseJob, endTime: 1700003600 };

    const result = await fetchJobsUtilizationBatch([completedJob], baseCluster);

    expect(mockGet).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });

  it('covers all running job nodes in a single matcher', async () => {
    const job2: JobRecord = {
      ...baseJob,
      jobId: 10002,
      nodes: ['gpu-node003'],
    };
    mockGet
      .mockResolvedValueOnce(makeVectorResponse([]))
      .mockResolvedValueOnce(makeVectorResponse([]));

    await fetchJobsUtilizationBatch([baseJob, job2], baseCluster);

    const cpuCall = mockGet.mock.calls[0];
    expect(cpuCall[1].query).toContain('gpu-node001');
    expect(cpuCall[1].query).toContain('gpu-node003');
  });

  it('returns empty map when cluster has no datasource UID', async () => {
    const cluster = { ...baseCluster, metricsDatasourceUid: '' };

    const result = await fetchJobsUtilizationBatch([baseJob], cluster);

    expect(mockGet).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });

  it('returns empty cpuPercent for a job whose nodes have no matching instance data', async () => {
    mockGet
      .mockResolvedValueOnce(makeVectorResponse([{ instance: 'other-node:9100', value: '50.0' }]))
      .mockResolvedValueOnce(makeVectorResponse([]));

    const result = await fetchJobsUtilizationBatch([baseJob], baseCluster);

    const util = result.get('a100-10001');
    expect(util?.cpuPercent).toBeUndefined();
  });
});
