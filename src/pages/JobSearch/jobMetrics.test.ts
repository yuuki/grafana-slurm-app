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

function makeMatrixResponse(
  items: Array<{ instance: string; values: Array<[number, string]> }>,
  instanceLabel = 'instance'
) {
  return of({
    data: {
      data: {
        resultType: 'matrix',
        result: items.map(({ instance, values }) => ({
          metric: { [instanceLabel]: instance },
          values,
        })),
      },
    },
  });
}

/** Shorthand: build a matrix response with uniform values at given timestamps. */
function makeUniformMatrix(
  items: Array<{ instance: string; value: string }>,
  timestamps: number[] = [1700000100, 1700000160, 1700000220],
  instanceLabel = 'instance'
) {
  return makeMatrixResponse(
    items.map(({ instance, value }) => ({
      instance,
      values: timestamps.map((ts) => [ts, value] as [number, string]),
    })),
    instanceLabel
  );
}

function getQueryFromCall(callIndex: number): string {
  const opts = mockFetch.mock.calls[callIndex][0];
  const params = new URLSearchParams(opts.data);
  return params.get('query') ?? '';
}

describe('fetchJobsUtilizationBatch', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('makes 2 range queries for cluster with GPU jobs and returns per-job averages', async () => {
    mockFetch
      .mockReturnValueOnce(
        makeUniformMatrix([
          { instance: 'gpu-node001:9100', value: '62.5' },
          { instance: 'gpu-node002:9100', value: '80.0' },
        ])
      )
      .mockReturnValueOnce(
        makeUniformMatrix([
          { instance: 'gpu-node001:9100', value: '75.0' },
          { instance: 'gpu-node002:9100', value: '90.0' },
        ])
      );

    const result = await fetchJobsUtilizationBatch([baseJob], baseCluster);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const util = result.get('a100-10001');
    // CPU: avg across 2 instances × 3 timestamps = avg(62.5,62.5,62.5,80,80,80) = 71.25
    expect(util?.cpuPercent).toBeCloseTo(71.25);
    // GPU: avg(75,75,75,90,90,90) = 82.5
    expect(util?.gpuPercent).toBeCloseTo(82.5);
  });

  it('makes only 1 query when no job has GPUs', async () => {
    const nonGpuJob = { ...baseJob, gpusTotal: 0 };
    mockFetch.mockReturnValueOnce(
      makeUniformMatrix([{ instance: 'gpu-node001:9100', value: '50.0' }])
    );

    await fetchJobsUtilizationBatch([nonGpuJob], baseCluster);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('includes completed jobs and returns their average utilization', async () => {
    const completedJob: JobRecord = {
      ...baseJob,
      state: 'COMPLETED',
      endTime: 1700003600,
    };
    const timestamps = [1700000100, 1700001000, 1700002000, 1700003000];
    mockFetch
      .mockReturnValueOnce(
        makeUniformMatrix(
          [{ instance: 'gpu-node001:9100', value: '55.0' }, { instance: 'gpu-node002:9100', value: '65.0' }],
          timestamps
        )
      )
      .mockReturnValueOnce(
        makeUniformMatrix(
          [{ instance: 'gpu-node001:9100', value: '70.0' }],
          timestamps
        )
      );

    const result = await fetchJobsUtilizationBatch([completedJob], baseCluster);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const util = result.get('a100-10001');
    // CPU: avg(55,55,55,55,65,65,65,65) = 60.0
    expect(util?.cpuPercent).toBeCloseTo(60.0);
    expect(util?.gpuPercent).toBeCloseTo(70.0);
  });

  it('filters data points to each job time range', async () => {
    const job1: JobRecord = { ...baseJob, jobId: 1, startTime: 100, endTime: 200 };
    const job2: JobRecord = { ...baseJob, jobId: 2, startTime: 300, endTime: 400, nodes: ['gpu-node003'] };

    // CPU series: node001/002 have data at ts=100,150,200,300,350,400; node003 at same timestamps
    mockFetch
      .mockReturnValueOnce(
        makeMatrixResponse([
          { instance: 'gpu-node001:9100', values: [[100, '40'], [150, '60'], [200, '50'], [300, '90'], [350, '80'], [400, '70']] },
          { instance: 'gpu-node002:9100', values: [[100, '30'], [150, '50'], [200, '40'], [300, '10'], [350, '20'], [400, '30']] },
          { instance: 'gpu-node003:9100', values: [[100, '10'], [150, '20'], [200, '30'], [300, '70'], [350, '80'], [400, '90']] },
        ])
      )
      .mockReturnValueOnce(makeMatrixResponse([]));

    const result = await fetchJobsUtilizationBatch([job1, job2], baseCluster);

    // Job1 (ts 100-200, nodes 001+002): avg(40,60,50,30,50,40) = 45.0
    expect(result.get('a100-1')?.cpuPercent).toBeCloseTo(45.0);
    // Job2 (ts 300-400, node 003): avg(70,80,90) = 80.0
    expect(result.get('a100-2')?.cpuPercent).toBeCloseTo(80.0);
  });

  it('covers all job nodes in a single matcher', async () => {
    const job2: JobRecord = {
      ...baseJob,
      jobId: 10002,
      nodes: ['gpu-node003'],
    };
    mockFetch
      .mockReturnValueOnce(makeUniformMatrix([]))
      .mockReturnValueOnce(makeUniformMatrix([]));

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

  it('returns undefined cpuPercent for a job whose nodes have no matching instance data', async () => {
    mockFetch
      .mockReturnValueOnce(makeUniformMatrix([{ instance: 'other-node:9100', value: '50.0' }]))
      .mockReturnValueOnce(makeUniformMatrix([]));

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
      .mockReturnValueOnce(makeUniformMatrix([{ instance: 'gpu-node001:9100', value: '55.0' }]))
      .mockReturnValueOnce(makeUniformMatrix([]));

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
      .mockReturnValueOnce(makeUniformMatrix([]))
      .mockReturnValueOnce(makeUniformMatrix([{ instance: 'gpu-node001:9100', value: '0.8' }]));

    await fetchJobsUtilizationBatch([baseJob], customCluster);

    const gpuQuery = getQueryFromCall(1);
    expect(gpuQuery).toContain('custom_gpu_metric');
    expect(gpuQuery).toContain('/ 100');
    expect(gpuQuery).not.toContain('DCGM_FI_DEV_GPU_UTIL');
  });

  it('falls back to default expressions when utilization fields are empty', async () => {
    const clusterWithEmpty = { ...baseCluster, cpuUtilizationExpr: '', gpuUtilizationExpr: '' };
    mockFetch
      .mockReturnValueOnce(makeUniformMatrix([]))
      .mockReturnValueOnce(makeUniformMatrix([]));

    await fetchJobsUtilizationBatch([baseJob], clusterWithEmpty);

    const cpuQuery = getQueryFromCall(0);
    expect(cpuQuery).toContain('node_cpu_seconds_total');
    const gpuQuery = getQueryFromCall(1);
    expect(gpuQuery).toContain('DCGM_FI_DEV_GPU_UTIL');
  });

  it('default GPU expression uses instanceMatcher without metricsFilter', async () => {
    const clusterWithFilter = {
      ...baseCluster,
      cpuUtilizationExpr: '',
      gpuUtilizationExpr: '',
      metricsFilterLabel: 'cluster',
      metricsFilterValue: 'slurm-a100',
    };
    mockFetch
      .mockReturnValueOnce(makeUniformMatrix([]))
      .mockReturnValueOnce(makeUniformMatrix([]));

    await fetchJobsUtilizationBatch([baseJob], clusterWithFilter);

    const cpuQuery = getQueryFromCall(0);
    // CPU default uses ${matcher} which includes the filter
    expect(cpuQuery).toContain('cluster="slurm-a100"');

    const gpuQuery = getQueryFromCall(1);
    // GPU default uses ${instanceMatcher} which excludes the filter
    expect(gpuQuery).toContain('gpu-node001');
    expect(gpuQuery).not.toContain('cluster=');
  });

  it('custom gpuUtilizationExpr can still use ${matcher} to include filter', async () => {
    const clusterWithCustomGpu = {
      ...baseCluster,
      metricsFilterLabel: 'cluster',
      metricsFilterValue: 'slurm-a100',
      gpuUtilizationExpr: 'avg by(${formattedLabel}) (custom_gpu{${matcher}})',
    };
    mockFetch
      .mockReturnValueOnce(makeUniformMatrix([]))
      .mockReturnValueOnce(makeUniformMatrix([]));

    await fetchJobsUtilizationBatch([baseJob], clusterWithCustomGpu);

    const gpuQuery = getQueryFromCall(1);
    expect(gpuQuery).toContain('custom_gpu');
    expect(gpuQuery).toContain('cluster="slurm-a100"');
  });

  it('sends POST to query_range with start, end, step parameters', async () => {
    mockFetch
      .mockReturnValueOnce(makeUniformMatrix([]))
      .mockReturnValueOnce(makeUniformMatrix([]));

    await fetchJobsUtilizationBatch([baseJob], baseCluster);

    const opts = mockFetch.mock.calls[0][0];
    expect(opts.method).toBe('POST');
    expect(opts.url).toContain('/api/v1/query_range');
    expect(opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const params = new URLSearchParams(opts.data);
    expect(params.get('start')).toBeTruthy();
    expect(params.get('end')).toBeTruthy();
    expect(params.get('step')).toMatch(/^\d+s$/);
  });

  it('returns empty map when all jobs have no nodes', async () => {
    const noNodeJob = { ...baseJob, nodes: [] as string[] };

    const result = await fetchJobsUtilizationBatch([noNodeJob], baseCluster);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });

  it('uses a step small enough for short jobs when mixed with long jobs', async () => {
    // 90-day range + 5-minute job: step must be <= 150s so the short job gets ≥2 data points
    const longJob: JobRecord = { ...baseJob, jobId: 1, startTime: 1000000, endTime: 8776000 }; // ~90 days
    const shortJob: JobRecord = { ...baseJob, jobId: 2, startTime: 8775700, endTime: 8776000, nodes: ['gpu-node003'] }; // 300s

    mockFetch
      .mockReturnValueOnce(
        makeMatrixResponse([
          { instance: 'gpu-node001:9100', values: [[8775700, '50'], [8775850, '60'], [8776000, '70']] },
          { instance: 'gpu-node003:9100', values: [[8775700, '40'], [8775850, '50'], [8776000, '60']] },
        ])
      )
      .mockReturnValueOnce(makeMatrixResponse([]));

    const result = await fetchJobsUtilizationBatch([longJob, shortJob], baseCluster);

    // Short job must have data points even in a wide time range
    const shortUtil = result.get('a100-2');
    expect(shortUtil?.cpuPercent).toBeDefined();
    expect(shortUtil?.cpuPercent).toBeCloseTo(50.0);
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
      .mockReturnValueOnce(
        makeUniformMatrix(manyNodes.map((node) => ({ instance: `${node}:9100`, value: '60.0' })))
      )
      .mockReturnValueOnce(
        makeUniformMatrix(manyNodes.map((node) => ({ instance: `${node}:9100`, value: '80.0' })))
      );

    const result = await fetchJobsUtilizationBatch([bigJob], baseCluster);

    expect(mockFetch).toHaveBeenCalledTimes(2);

    const util = result.get('a100-20001');
    expect(util?.cpuPercent).toBeCloseTo(60.0);
    expect(util?.gpuPercent).toBeCloseTo(80.0);
  });
});
