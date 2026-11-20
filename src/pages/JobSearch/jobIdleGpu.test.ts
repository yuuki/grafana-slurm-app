import { ClusterSummary, JobRecord } from '../../api/types';
import { FakeGpu, FakeMetrics } from '../JobDashboard/efficiency/__fixtures__/fakeMetrics';
import { describeJobIdleGpu, fetchJobsIdleGpuBatch, JobIdleGpu, MAX_BATCH_STEP_SECONDS, planIdleGpuBatch, sortJobsByIdleGpu } from './jobIdleGpu';
import { jobKey } from './model';

// A multiple of 60, so one-minute buckets hold two 30 s scrapes each.
const START = 1_700_000_040;
const HOUR = 3600;
const NOW = START + 100 * HOUR;

const cluster: ClusterSummary = {
  id: 'a100',
  displayName: 'A100',
  slurmClusterName: 'gpu_cluster',
  metricsDatasourceUid: 'prom-main',
  metricsType: 'prometheus',
  aggregationNodeLabels: ['instance'],
  instanceLabel: 'instance',
  nodeMatcherMode: 'host:port',
  defaultTemplateId: 'overview',
  metricsFilterLabel: '',
  metricsFilterValue: '',
};

function makeJob(jobId: number, overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    clusterId: 'a100',
    jobId,
    name: 'train',
    user: 'researcher1',
    account: 'ml-team',
    partition: 'gpu-a100',
    state: 'COMPLETED',
    nodes: ['gpu-node001'],
    nodeList: 'gpu-node001',
    nodeCount: 1,
    gpusTotal: 8,
    cpusTotal: 16,
    submitTime: START - 60,
    startTime: START,
    endTime: START + HOUR,
    exitCode: 0,
    workDir: '/tmp',
    tres: '1=16,1001=8',
    templateId: 'overview',
    ...overrides,
  };
}

/** Eight GPUs of a node; utilization(index, time) returns undefined for a missing scrape. */
function gpus(node: string, utilization: (index: number, time: number) => number | undefined): FakeGpu[] {
  return Array.from({ length: 8 }, (_, index) => ({
    instance: `${node}:9400`,
    gpu: String(index),
    utilization: (time: number) => utilization(index, time),
  }));
}

function entry(result: Map<string, JobIdleGpu>, jobId: number): JobIdleGpu | undefined {
  return result.get(jobKey('a100', jobId));
}

describe('fetchJobsIdleGpuBatch', () => {
  it('scores a page of jobs with two queries, whatever the number of jobs', async () => {
    const jobs = [
      makeJob(1),
      makeJob(2, { nodes: ['gpu-node002'], nodeList: 'gpu-node002' }),
      makeJob(3, { nodes: ['gpu-node003'], nodeList: 'gpu-node003', startTime: START + HOUR, endTime: START + 3 * HOUR }),
    ];
    const metrics = new FakeMetrics({
      gpus: [
        ...gpus('gpu-node001', () => 90),
        ...gpus('gpu-node002', (index) => (index < 4 ? 85 : 0)),
        ...gpus('gpu-node003', (index, time) => (index === 0 && time <= START + 2 * HOUR ? 70 : 0)),
      ],
    });

    const result = await fetchJobsIdleGpuBatch(jobs, cluster, NOW, metrics);

    expect(metrics.queries.map((query) => query.expr)).toEqual([
      'count by (instance) (max_over_time(DCGM_FI_DEV_GPU_UTIL{instance=~"(gpu-node001|gpu-node002|gpu-node003):[0-9]+"}[60s]))',
      'count by (instance) (max_over_time(DCGM_FI_DEV_GPU_UTIL{instance=~"(gpu-node001|gpu-node002|gpu-node003):[0-9]+"}[60s]) > 5)',
    ]);
    expect(entry(result, 1)).toEqual({ status: 'ok', idleGpuSeconds: 0, scoredGpuSeconds: 8 * HOUR, sharedNodes: false });
    expect(entry(result, 2)).toEqual({ status: 'ok', idleGpuSeconds: 4 * HOUR, scoredGpuSeconds: 8 * HOUR, sharedNodes: false });
    // Seven GPUs idle for two hours, and the eighth for the second hour.
    expect(entry(result, 3)).toEqual({ status: 'ok', idleGpuSeconds: 15 * HOUR, scoredGpuSeconds: 16 * HOUR, sharedNodes: false });
  });

  it('uses only the buckets inside a job, so the jobs before and after it on the node do not count', async () => {
    const job = makeJob(1, { startTime: START + 90, endTime: START + HOUR + 30 });
    const metrics = new FakeMetrics({
      // Busy until the job starts and after it ends, idle in between.
      gpus: gpus('gpu-node001', (_index, time) => (time > job.startTime && time <= job.endTime ? 0 : 100)),
    });

    const result = await fetchJobsIdleGpuBatch([job], cluster, NOW, metrics);

    // The grid starts at the job start; its last bucket crosses the job end and is left out.
    expect(entry(result, 1)).toEqual({ status: 'ok', idleGpuSeconds: 8 * 59 * 60, scoredGpuSeconds: 8 * 59 * 60, sharedNodes: false });
  });

  it('gives a lower bound for jobs on a node they share', async () => {
    const jobs = [makeJob(1, { gpusTotal: 4 }), makeJob(2, { gpusTotal: 2 })];
    const metrics = new FakeMetrics({ gpus: gpus('gpu-node001', (index) => (index < 3 ? 80 : 0)) });

    const result = await fetchJobsIdleGpuBatch(jobs, cluster, NOW, metrics);

    // Three GPUs of the node were active: at least one of job 1's four was idle, none of job 2's two provably.
    expect(entry(result, 1)).toEqual({ status: 'ok', idleGpuSeconds: HOUR, scoredGpuSeconds: 4 * HOUR, sharedNodes: true });
    expect(entry(result, 2)).toEqual({ status: 'ok', idleGpuSeconds: 0, scoredGpuSeconds: 2 * HOUR, sharedNodes: true });
  });

  it('reports jobs without telemetry as no data and leaves time without telemetry out', async () => {
    const jobs = [makeJob(1), makeJob(2, { nodes: ['gpu-node002'], nodeList: 'gpu-node002' })];
    const metrics = new FakeMetrics({
      // gpu-node002 has no series; gpu-node001 reports only in the second half hour.
      gpus: gpus('gpu-node001', (_index, time) => (time > START + HOUR / 2 ? 0 : undefined)),
    });

    const result = await fetchJobsIdleGpuBatch(jobs, cluster, NOW, metrics);

    expect(entry(result, 1)).toEqual({ status: 'ok', idleGpuSeconds: 4 * HOUR, scoredGpuSeconds: 8 * HOUR, sharedNodes: false });
    expect(entry(result, 2)).toEqual({ status: 'no-data' });
  });

  it('gives every job that has nothing to score a state, and sends no query for them', async () => {
    const metrics = new FakeMetrics();
    const result = await fetchJobsIdleGpuBatch(
      [
        makeJob(1, { gpusTotal: 0 }),
        makeJob(2, { state: 'PENDING', startTime: 0, endTime: 0, nodes: [] }),
        makeJob(3, { endTime: START + 120 }),
      ],
      cluster,
      NOW,
      metrics
    );

    expect(entry(result, 1)).toEqual({ status: 'not-scored', reason: 'no-gpus' });
    expect(entry(result, 2)).toEqual({ status: 'not-scored', reason: 'not-started' });
    expect(entry(result, 3)).toEqual({ status: 'not-scored', reason: 'too-short' });
    expect(metrics.queries).toHaveLength(0);
  });

  it('scores a running job up to now', async () => {
    const now = START + 30 * 60;
    const metrics = new FakeMetrics({ gpus: gpus('gpu-node001', (index) => (index === 0 ? 90 : 0)) });

    const result = await fetchJobsIdleGpuBatch([makeJob(1, { state: 'RUNNING', endTime: 0 })], cluster, now, metrics);

    expect(entry(result, 1)).toEqual({ status: 'ok', idleGpuSeconds: 7 * 30 * 60, scoredGpuSeconds: 8 * 30 * 60, sharedNodes: false });
    expect(metrics.queries.every((query) => query.end === now)).toBe(true);
  });

  it('does not compute a page that would need buckets longer than the limit', async () => {
    const nodes = Array.from({ length: 400 }, (_, index) => `gpu-node${index}`);
    const jobs = [makeJob(1, { nodes, nodeCount: 400, gpusTotal: 3200, endTime: START + 7 * 24 * HOUR }), makeJob(2, { gpusTotal: 0 })];
    const metrics = new FakeMetrics();

    const result = await fetchJobsIdleGpuBatch(jobs, cluster, NOW, metrics);

    expect(entry(result, 1)).toEqual({ status: 'not-computed', reason: 'range-too-wide' });
    expect(entry(result, 2)).toEqual({ status: 'not-scored', reason: 'no-gpus' });
    expect(metrics.queries).toHaveLength(0);
  });

  it('does not compute a job that is shorter than the page buckets', async () => {
    // 100 nodes over three days: 240 buckets of 18 minutes.
    const nodes = Array.from({ length: 100 }, (_, index) => `gpu-node${index}`);
    const long = makeJob(1, { nodes, nodeCount: 100, gpusTotal: 800, endTime: START + 72 * HOUR });
    const short = makeJob(2, { nodes: ['gpu-node0'], startTime: START + 600, endTime: START + 1200 });
    const metrics = new FakeMetrics({ gpus: gpus('gpu-node0', () => 0), scrapeInterval: 300 });

    const result = await fetchJobsIdleGpuBatch([long, short], cluster, NOW, metrics);

    expect(metrics.queries[0].step).toBe(1080);
    expect(entry(result, 2)).toEqual({ status: 'not-computed', reason: 'no-full-bucket' });
  });

  it.each([
    [{ ...cluster, metricsDatasourceUid: '' }, 'no-datasource'],
    [{ ...cluster, efficiency: { gpuUtilizationMetric: 'up{}' } }, 'invalid-settings'],
  ])('does not query for a cluster that cannot be scored', async (target, reason) => {
    const metrics = new FakeMetrics();
    const result = await fetchJobsIdleGpuBatch([makeJob(1)], target, NOW, metrics);

    expect(entry(result, 1)).toEqual({ status: 'not-computed', reason });
    expect(metrics.queries).toHaveLength(0);
  });

  it('marks the jobs of a failed batch as not computed instead of rejecting', async () => {
    const metrics = new FakeMetrics({ gpus: gpus('gpu-node001', () => 0), failOn: /GPU_UTIL/ });
    const result = await fetchJobsIdleGpuBatch([makeJob(1), makeJob(2, { gpusTotal: 0 })], cluster, NOW, metrics);

    expect(entry(result, 1)).toEqual({ status: 'not-computed', reason: 'query-failed' });
    expect(entry(result, 2)).toEqual({ status: 'not-scored', reason: 'no-gpus' });
  });

  it('follows the cluster settings: metric, idle baseline, labels and filter', async () => {
    const target: ClusterSummary = {
      ...cluster,
      instanceLabel: 'Hostname',
      nodeMatcherMode: 'hostname',
      metricsFilterLabel: 'cluster',
      metricsFilterValue: 'slurm-a100',
      efficiency: { gpuUtilizationMetric: 'nvidia_gpu_utilization', idleGpuUtilizationPercent: 20 },
    };
    const metrics = new FakeMetrics({
      instanceLabel: 'Hostname',
      utilizationMetric: 'nvidia_gpu_utilization',
      gpus: gpus('gpu-node001', (index) => (index === 0 ? 90 : 15)).map((item) => ({ ...item, instance: 'gpu-node001' })),
    });

    const result = await fetchJobsIdleGpuBatch([makeJob(1)], target, NOW, metrics);

    expect(metrics.queries[1].expr).toBe(
      'count by (Hostname) (max_over_time(nvidia_gpu_utilization{Hostname=~"(gpu-node001)",cluster="slurm-a100"}[60s]) > 20)'
    );
    // 15% utilization is idle against a 20% baseline.
    expect(entry(result, 1)).toEqual({ status: 'ok', idleGpuSeconds: 7 * HOUR, scoredGpuSeconds: 8 * HOUR, sharedNodes: false });
  });
});

describe('planIdleGpuBatch', () => {
  it('keeps nodes x buckets under the point budget and buckets at least a minute long', () => {
    const nodes = Array.from({ length: 100 }, (_, index) => `n${index}`);
    const plan = planIdleGpuBatch([makeJob(1, { nodes, endTime: START + 24 * HOUR }), makeJob(2, { startTime: START - HOUR })], NOW);

    // 25 hours on 101 nodes: 24000 / 101 = 237 buckets of 380 s.
    expect(plan).toMatchObject({ gridStart: START - HOUR, step: 380, buckets: 237 });
    expect(plan!.nodes).toHaveLength(101);
    expect(plan!.nodes.length * plan!.buckets).toBeLessThanOrEqual(24_000);
    expect(planIdleGpuBatch([makeJob(1)], NOW)).toMatchObject({ step: 60, buckets: 60 });
  });

  it('refuses a page whose buckets would be longer than the limit', () => {
    expect(planIdleGpuBatch([makeJob(1, { endTime: START + 500 * MAX_BATCH_STEP_SECONDS })], NOW)).toMatchObject({ step: MAX_BATCH_STEP_SECONDS });
    expect(planIdleGpuBatch([makeJob(1, { endTime: START + 500 * MAX_BATCH_STEP_SECONDS + 1 })], NOW)).toBeNull();
  });
});

describe('sortJobsByIdleGpu', () => {
  it('puts the most idle GPU time first and keeps jobs without a value in their order at the end', () => {
    const jobs = [makeJob(1), makeJob(2), makeJob(3), makeJob(4), makeJob(5)];
    const idle = new Map<string, JobIdleGpu>([
      [jobKey('a100', 1), { status: 'no-data' }],
      [jobKey('a100', 2), { status: 'ok', idleGpuSeconds: 100, scoredGpuSeconds: 1000, sharedNodes: false }],
      [jobKey('a100', 3), { status: 'not-scored', reason: 'no-gpus' }],
      [jobKey('a100', 4), { status: 'ok', idleGpuSeconds: 900, scoredGpuSeconds: 1000, sharedNodes: false }],
    ]);

    expect(sortJobsByIdleGpu(jobs, idle).map((job) => job.jobId)).toEqual([4, 2, 1, 3, 5]);
    // The input order is not changed.
    expect(jobs.map((job) => job.jobId)).toEqual([1, 2, 3, 4, 5]);
  });

  it('ranks a job with zero idle time above jobs without a value', () => {
    const jobs = [makeJob(1), makeJob(2)];
    const idle = new Map<string, JobIdleGpu>([[jobKey('a100', 2), { status: 'ok', idleGpuSeconds: 0, scoredGpuSeconds: 1000, sharedNodes: false }]]);
    expect(sortJobsByIdleGpu(jobs, idle).map((job) => job.jobId)).toEqual([2, 1]);
  });
});

describe('describeJobIdleGpu', () => {
  it.each<[JobIdleGpu | undefined, string, string]>([
    [undefined, '...', 'Scoring idle GPU time'],
    [
      { status: 'ok', idleGpuSeconds: 4 * HOUR, scoredGpuSeconds: 8 * HOUR, sharedNodes: false },
      '≥ 4.0',
      'At least 4.0 GPU-hours idle, 50% of the 8.0 allocated GPU-hours scored.',
    ],
    [
      { status: 'ok', idleGpuSeconds: HOUR, scoredGpuSeconds: 4 * HOUR, sharedNodes: true },
      '≥ 1.0',
      'At least 1.0 GPU-hours idle, 25% of the 4.0 allocated GPU-hours scored. The job shares its nodes, so this counts only GPUs that no job used.',
    ],
    [{ status: 'no-data' }, 'no data', "No GPU telemetry for the job's nodes and time. This does not mean that the GPUs were idle."],
    [{ status: 'not-scored', reason: 'no-gpus' }, '-', 'The job allocated no GPUs.'],
    [{ status: 'not-scored', reason: 'too-short' }, '-', 'The job ran for less than 5 minutes.'],
    [
      { status: 'not-computed', reason: 'range-too-wide' },
      'n/c',
      'Not computed. The jobs of this page span too many nodes and too much time to score together. Narrow the search.',
    ],
    [{ status: 'not-computed', reason: 'query-failed' }, 'n/c', 'Not computed. The metrics query failed.'],
  ])('describes %j', (value, text, title) => {
    expect(describeJobIdleGpu(value)).toEqual({ text, title });
  });
});
