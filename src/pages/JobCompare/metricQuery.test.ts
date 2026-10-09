import { of, throwError } from 'rxjs';

const mockFetch = jest.fn();

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({ fetch: mockFetch }),
}));

import { ClusterSummary, JobRecord } from '../../api/types';
import { buildCompareExprs, computeStep, fetchCompareSeries, planQueryBatches } from './metricQuery';

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

function makeJob(jobId: number, node: string, startTime: number, endTime: number): JobRecord {
  return {
    clusterId: 'a100',
    jobId,
    name: 'train',
    user: 'alice',
    account: 'ml',
    partition: 'gpu',
    state: endTime > 0 ? 'COMPLETED' : 'RUNNING',
    nodes: [node],
    nodeList: node,
    nodeCount: 1,
    gpusTotal: 8,
    submitTime: startTime,
    startTime,
    endTime,
    exitCode: 0,
    workDir: '/tmp',
    tres: '',
    templateId: 'overview',
  };
}

function matrix(items: Array<{ instance: string; values: Array<[number, string]> }>) {
  return of({
    data: {
      data: { result: items.map((item) => ({ metric: { instance: item.instance }, values: item.values })) },
    },
  });
}

describe('buildCompareExprs', () => {
  it('aggregates gauges per instance', () => {
    expect(buildCompareExprs('DCGM_FI_DEV_GPU_UTIL', 'gauge', 'instance=~"(n1)"', 'instance')).toEqual({
      mean: 'avg by(instance) (DCGM_FI_DEV_GPU_UTIL{instance=~"(n1)"})',
      min: 'min by(instance) (DCGM_FI_DEV_GPU_UTIL{instance=~"(n1)"})',
      max: 'max by(instance) (DCGM_FI_DEV_GPU_UTIL{instance=~"(n1)"})',
    });
  });

  it('applies rate() to counters', () => {
    expect(buildCompareExprs('node_network_receive_bytes_total', 'counter', 'a="b"', 'instance').mean).toBe(
      'avg by(instance) (rate(node_network_receive_bytes_total{a="b"}[5m]))'
    );
  });
});

describe('planQueryBatches', () => {
  it('merges jobs whose windows are close and splits distant ones', () => {
    const batches = planQueryBatches(
      [
        makeJob(3, 'n3', 100_000, 103_600),
        makeJob(1, 'n1', 1000, 4600),
        makeJob(2, 'n2', 5000, 8000),
        makeJob(4, 'n4', 0, 0),
      ],
      200_000
    );
    expect(batches.map((b) => b.jobs.map((j) => j.jobId))).toEqual([[1, 2], [3]]);
    expect(batches[0]).toMatchObject({ start: 1000, end: 8000 });
  });
});

describe('computeStep', () => {
  it('targets about 200 points for the shortest job with a 15s floor', () => {
    const batch = { jobs: [makeJob(1, 'n1', 0, 40_000)], start: 0, end: 40_000 };
    expect(computeStep(batch, 0)).toBe(200);
    const short = { jobs: [makeJob(1, 'n1', 0, 600)], start: 0, end: 600 };
    expect(computeStep(short, 0)).toBe(15);
  });

  it('stays under the Prometheus 11000 points limit', () => {
    const batch = { jobs: [makeJob(1, 'n1', 0, 600), makeJob(2, 'n2', 0, 1_000_000)], start: 0, end: 1_000_000 };
    expect(computeStep(batch, 0)).toBe(91);
  });
});

describe('fetchCompareSeries', () => {
  beforeEach(() => mockFetch.mockReset());

  it('queries mean/min/max once per batch and slices each job', async () => {
    mockFetch.mockImplementation((req: { data: string }) => {
      const query = new URLSearchParams(req.data).get('query') ?? '';
      const offset = query.startsWith('min') ? -1 : query.startsWith('max') ? 1 : 0;
      return matrix([
        { instance: 'n1', values: [[1000, String(10 + offset)], [2000, String(20 + offset)]] },
        { instance: 'n2', values: [[5000, String(30 + offset)]] },
      ]);
    });
    const result = await fetchCompareSeries({
      jobs: [makeJob(1, 'n1', 1000, 4600), makeJob(2, 'n2', 5000, 8000)],
      cluster,
      metricName: 'DCGM_FI_DEV_GPU_UTIL',
      metricType: 'gauge',
      now: 10_000,
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);
    const firstQuery = new URLSearchParams(mockFetch.mock.calls[0][0].data).get('query');
    expect(firstQuery).toContain('instance=~"(n1|n2)"');
    expect(firstQuery).toContain('cluster="slurm-a100"');
    expect(result.series.get('a100-1')).toEqual({ times: [1000, 2000], mean: [10, 20], min: [9, 19], max: [11, 21] });
    expect(result.series.get('a100-2')?.mean).toEqual([30]);
    expect(result.failedJobKeys.size).toBe(0);
  });

  it('marks every job in a failed batch as failed', async () => {
    mockFetch.mockReturnValue(throwError(() => ({ status: 422 })));
    const result = await fetchCompareSeries({
      jobs: [makeJob(1, 'n1', 1000, 4600)],
      cluster,
      metricName: 'up',
      metricType: 'gauge',
      now: 10_000,
    });
    expect([...result.failedJobKeys]).toEqual(['a100-1']);
    expect(result.series.size).toBe(0);
  });

  it('fails every job when the cluster has no metrics datasource', async () => {
    const result = await fetchCompareSeries({
      jobs: [makeJob(1, 'n1', 1000, 4600)],
      cluster: { ...cluster, metricsDatasourceUid: '' },
      metricName: 'up',
      metricType: 'gauge',
      now: 10_000,
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect([...result.failedJobKeys]).toEqual(['a100-1']);
  });
});
