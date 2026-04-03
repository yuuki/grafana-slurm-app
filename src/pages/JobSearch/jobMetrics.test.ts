const mockPost = jest.fn();

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({ post: mockPost }),
}));

// Use model.ts as-is to exercise the actual buildInstanceMatcher and buildFilterMatcher logic

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
    mockPost.mockReset();
  });

  it('makes 2 batch queries for cluster with GPU jobs and returns per-job averages', async () => {
    mockPost
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

    expect(mockPost).toHaveBeenCalledTimes(2);
    const util = result.get('a100-10001');
    // CPU: avg(62.5, 80.0) = 71.25
    expect(util?.cpuPercent).toBeCloseTo(71.25);
    // GPU: avg(75.0, 90.0) = 82.5
    expect(util?.gpuPercent).toBeCloseTo(82.5);
  });

  it('makes only 1 query when no job has GPUs', async () => {
    const nonGpuJob = { ...baseJob, gpusTotal: 0 };
    mockPost.mockResolvedValueOnce(
      makeVectorResponse([{ instance: 'gpu-node001:9100', value: '50.0' }])
    );

    await fetchJobsUtilizationBatch([nonGpuJob], baseCluster);

    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('skips completed jobs (endTime > 0) and returns empty map', async () => {
    const completedJob = { ...baseJob, endTime: 1700003600 };

    const result = await fetchJobsUtilizationBatch([completedJob], baseCluster);

    expect(mockPost).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });

  it('covers all running job nodes in a single matcher', async () => {
    const job2: JobRecord = {
      ...baseJob,
      jobId: 10002,
      nodes: ['gpu-node003'],
    };
    mockPost
      .mockResolvedValueOnce(makeVectorResponse([]))
      .mockResolvedValueOnce(makeVectorResponse([]));

    await fetchJobsUtilizationBatch([baseJob, job2], baseCluster);

    const cpuCall = mockPost.mock.calls[0];
    expect(cpuCall[1].query).toContain('gpu-node001');
    expect(cpuCall[1].query).toContain('gpu-node003');
  });

  it('returns empty map when cluster has no datasource UID', async () => {
    const cluster = { ...baseCluster, metricsDatasourceUid: '' };

    const result = await fetchJobsUtilizationBatch([baseJob], cluster);

    expect(mockPost).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });

  it('returns empty cpuPercent for a job whose nodes have no matching instance data', async () => {
    mockPost
      .mockResolvedValueOnce(makeVectorResponse([{ instance: 'other-node:9100', value: '50.0' }]))
      .mockResolvedValueOnce(makeVectorResponse([]));

    const result = await fetchJobsUtilizationBatch([baseJob], baseCluster);

    const util = result.get('a100-10001');
    expect(util?.cpuPercent).toBeUndefined();
  });

  it('handles many nodes in a single POST query without URL length issues', async () => {
    const manyNodes = Array.from({ length: 100 }, (_, i) => `gpu-node${String(i + 1).padStart(3, '0')}`);
    const bigJob: JobRecord = {
      ...baseJob,
      jobId: 20001,
      nodes: manyNodes,
      gpusTotal: 8,
    };

    mockPost
      .mockResolvedValueOnce(makeVectorResponse(
        manyNodes.map((node) => ({ instance: `${node}:9100`, value: '60.0' }))
      ))
      .mockResolvedValueOnce(makeVectorResponse(
        manyNodes.map((node) => ({ instance: `${node}:9100`, value: '80.0' }))
      ));

    const result = await fetchJobsUtilizationBatch([bigJob], baseCluster);

    // POST body carries the query, so 100 nodes still results in only 2 queries (CPU + GPU)
    expect(mockPost).toHaveBeenCalledTimes(2);

    const util = result.get('a100-20001');
    expect(util?.cpuPercent).toBeCloseTo(60.0);
    expect(util?.gpuPercent).toBeCloseTo(80.0);
  });
});
