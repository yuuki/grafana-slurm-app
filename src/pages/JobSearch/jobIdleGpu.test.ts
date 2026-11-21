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
    expect(entry(result, 1)).toEqual({ status: 'ok', idleGpuSeconds: 0, scoredGpuSeconds: 8 * HOUR, unobservedGpuSeconds: 0, sharedNodes: false });
    expect(entry(result, 2)).toEqual({ status: 'ok', idleGpuSeconds: 4 * HOUR, scoredGpuSeconds: 8 * HOUR, unobservedGpuSeconds: 0, sharedNodes: false });
    // Seven GPUs idle for two hours, and the eighth for the second hour.
    expect(entry(result, 3)).toEqual({ status: 'ok', idleGpuSeconds: 15 * HOUR, scoredGpuSeconds: 16 * HOUR, unobservedGpuSeconds: 0, sharedNodes: false });
  });

  it('uses only the buckets inside a job, so the jobs before and after it on the node do not count', async () => {
    const job = makeJob(1, { startTime: START + 90, endTime: START + HOUR + 30 });
    const metrics = new FakeMetrics({
      // Busy until the job starts and after it ends, idle in between.
      gpus: gpus('gpu-node001', (_index, time) => (time > job.startTime && time <= job.endTime ? 0 : 100)),
    });

    const result = await fetchJobsIdleGpuBatch([job], cluster, NOW, metrics);

    // The buckets lie on full minutes. The ones that cross the job start (at :01:30)
    // and the job end (at 1:00:30) are left out: 58 buckets remain.
    expect(metrics.queries[0]).toMatchObject({ start: START + 120, step: 60 });
    expect(entry(result, 1)).toEqual({ status: 'ok', idleGpuSeconds: 8 * 58 * 60, scoredGpuSeconds: 8 * 58 * 60, unobservedGpuSeconds: 0, sharedNodes: false });
  });

  it('gives a lower bound for jobs on a node they share', async () => {
    const jobs = [makeJob(1, { gpusTotal: 4 }), makeJob(2, { gpusTotal: 2 })];
    const metrics = new FakeMetrics({ gpus: gpus('gpu-node001', (index) => (index < 3 ? 80 : 0)) });

    const result = await fetchJobsIdleGpuBatch(jobs, cluster, NOW, metrics);

    // Three GPUs of the node were active: at least one of job 1's four was idle, none of job 2's two provably.
    expect(entry(result, 1)).toEqual({ status: 'ok', idleGpuSeconds: HOUR, scoredGpuSeconds: 4 * HOUR, unobservedGpuSeconds: 0, sharedNodes: true });
    expect(entry(result, 2)).toEqual({ status: 'ok', idleGpuSeconds: 0, scoredGpuSeconds: 2 * HOUR, unobservedGpuSeconds: 0, sharedNodes: true });
  });

  it('reports jobs without telemetry as no data and leaves time without telemetry out', async () => {
    const jobs = [makeJob(1), makeJob(2, { nodes: ['gpu-node002'], nodeList: 'gpu-node002' })];
    const metrics = new FakeMetrics({
      // gpu-node002 has no series; gpu-node001 reports only in the second half hour.
      gpus: gpus('gpu-node001', (_index, time) => (time > START + HOUR / 2 ? 0 : undefined)),
    });

    const result = await fetchJobsIdleGpuBatch(jobs, cluster, NOW, metrics);

    expect(entry(result, 1)).toEqual({ status: 'ok', idleGpuSeconds: 4 * HOUR, scoredGpuSeconds: 8 * HOUR, unobservedGpuSeconds: 4 * HOUR, sharedNodes: false });
    expect(entry(result, 2)).toEqual({ status: 'no-data' });
  });

  it('does not take the idle GPUs of a shared node for the job own when another node of the job has no exporter', async () => {
    // Each job holds busy GPUs on both nodes. gpu-node002 has no exporter;
    // the idle GPUs of gpu-node001 belong to nobody.
    const twoNodes = { nodes: ['gpu-node001', 'gpu-node002'], nodeList: 'gpu-node[001-002]', nodeCount: 2 };
    const jobs = [makeJob(1, { ...twoNodes, gpusTotal: 8 }), makeJob(2, { ...twoNodes, gpusTotal: 4 })];
    const metrics = new FakeMetrics({ gpus: gpus('gpu-node001', (index) => (index < 4 ? 95 : 0)) });

    const result = await fetchJobsIdleGpuBatch(jobs, cluster, NOW, metrics);

    // Job 1: eight GPUs report, as many as it allocated. Job 2: more than it allocated. Neither count proves anything.
    const want = { status: 'not-computed', reason: 'nodes-without-telemetry', nodes: ['gpu-node002'] };
    expect(entry(result, 1)).toEqual(want);
    expect(entry(result, 2)).toEqual(want);
    expect(sortJobsByIdleGpu(jobs, result).map((job) => job.jobId)).toEqual([1, 2]);
  });

  it('does not compute a job whose nodes report fewer GPUs than it allocated', async () => {
    const metrics = new FakeMetrics({ gpus: gpus('gpu-node001', () => 0).slice(0, 4) });
    const result = await fetchJobsIdleGpuBatch([makeJob(1)], cluster, NOW, metrics);

    expect(entry(result, 1)).toEqual({ status: 'not-computed', reason: 'fewer-gpus-than-allocated' });
  });

  it('counts no idle GPU time on shared nodes while the exporter of one node is down', async () => {
    // The job holds GPUs 0-3 of each node, busy all the time. GPUs 4-7 are
    // idle and not the job's. gpu-node002 stops reporting after half an hour.
    const job = makeJob(1, { nodes: ['gpu-node001', 'gpu-node002'], nodeList: 'gpu-node[001-002]', nodeCount: 2 });
    const metrics = new FakeMetrics({
      gpus: [
        ...gpus('gpu-node001', (index) => (index < 4 ? 95 : 0)),
        ...gpus('gpu-node002', (index, time) => (time > START + HOUR / 2 ? undefined : index < 4 ? 95 : 0)),
      ],
    });

    const result = await fetchJobsIdleGpuBatch([job], cluster, NOW, metrics);

    // In the second half the eight GPUs of gpu-node001 are as many as the job allocated, and four are idle.
    expect(entry(result, 1)).toEqual({
      status: 'ok',
      idleGpuSeconds: 0,
      scoredGpuSeconds: 8 * HOUR,
      unobservedGpuSeconds: 4 * HOUR,
      sharedNodes: true,
    });
  });

  it('does not compute a job on shared nodes that are never scraped in the same bucket', async () => {
    // One scrape every two minutes, the two nodes one minute apart.
    const job = makeJob(1, { nodes: ['gpu-node001', 'gpu-node002'], nodeList: 'gpu-node[001-002]', nodeCount: 2 });
    const every2Minutes = (phase: number) => (index: number, time: number) => (time % 120 === phase ? (index < 4 ? 95 : 0) : undefined);
    const metrics = new FakeMetrics({ gpus: [...gpus('gpu-node001', every2Minutes(30)), ...gpus('gpu-node002', every2Minutes(90))] });

    const result = await fetchJobsIdleGpuBatch([job], cluster, NOW, metrics);

    expect(entry(result, 1)).toEqual({ status: 'not-computed', reason: 'incomplete-telemetry' });
  });

  it('counts the GPUs of an exclusive node that stop reporting as unobserved, not as idle', async () => {
    // GPUs 4-7 report nothing in the second half hour.
    const metrics = new FakeMetrics({ gpus: gpus('gpu-node001', (index, time) => (index >= 4 && time > START + HOUR / 2 ? undefined : 0)) });
    const result = await fetchJobsIdleGpuBatch([makeJob(1)], cluster, NOW, metrics);

    expect(entry(result, 1)).toEqual({
      status: 'ok',
      idleGpuSeconds: 6 * HOUR,
      scoredGpuSeconds: 8 * HOUR,
      unobservedGpuSeconds: 2 * HOUR,
      sharedNodes: false,
    });
  });

  it('gives every job that has nothing to score a state, and sends no query for them', async () => {
    const metrics = new FakeMetrics();
    const result = await fetchJobsIdleGpuBatch(
      [
        makeJob(1, { gpusTotal: 0 }),
        makeJob(2, { state: 'PENDING', startTime: 0, endTime: 0, nodes: [] }),
        makeJob(3, { endTime: START + 120 }),
        // Suspended for ten minutes of its hour: idle GPUs then are not waste of the job.
        makeJob(4, { suspendedSeconds: 600 }),
        makeJob(5, { state: 'SUSPENDED', endTime: 0 }),
        makeJob(6, { suspendedSeconds: -1 }),
        // Recorded as running 98 hours past a limit of one hour: probably a job whose end slurmdbd missed.
        makeJob(7, { state: 'RUNNING', endTime: 0, timeLimitSeconds: HOUR }),
      ],
      cluster,
      NOW,
      metrics
    );

    expect(entry(result, 1)).toEqual({ status: 'not-scored', reason: 'no-gpus' });
    expect(entry(result, 2)).toEqual({ status: 'not-scored', reason: 'not-started' });
    expect(entry(result, 3)).toEqual({ status: 'not-scored', reason: 'too-short' });
    expect(entry(result, 4)).toEqual({ status: 'not-scored', reason: 'suspended' });
    expect(entry(result, 5)).toEqual({ status: 'not-scored', reason: 'suspended' });
    expect(entry(result, 6)).toEqual({ status: 'not-scored', reason: 'suspended' });
    expect(entry(result, 7)).toEqual({ status: 'not-scored', reason: 'past-time-limit' });
    expect(metrics.queries).toHaveLength(0);
  });

  it('scores a running job up to now', async () => {
    const now = START + 30 * 60;
    const metrics = new FakeMetrics({ gpus: gpus('gpu-node001', (index) => (index === 0 ? 90 : 0)) });

    const result = await fetchJobsIdleGpuBatch([makeJob(1, { state: 'RUNNING', endTime: 0 })], cluster, now, metrics);

    expect(entry(result, 1)).toEqual({ status: 'ok', idleGpuSeconds: 7 * 30 * 60, scoredGpuSeconds: 8 * 30 * 60, unobservedGpuSeconds: 0, sharedNodes: false });
    expect(metrics.queries.every((query) => query.end === now)).toBe(true);
  });

  it('does not compute a page that would need buckets longer than the limit', async () => {
    const nodes = Array.from({ length: 400 }, (_, index) => `gpu-node${index}`);
    // 400 nodes leave 60 buckets, which would have to be 12 hours long for 30 days.
    const jobs = [makeJob(1, { nodes, nodeCount: 400, gpusTotal: 3200, endTime: START + 30 * 24 * HOUR }), makeJob(2, { gpusTotal: 0 })];
    const metrics = new FakeMetrics();

    const result = await fetchJobsIdleGpuBatch(jobs, cluster, NOW, metrics);

    expect(entry(result, 1)).toEqual({ status: 'not-computed', reason: 'range-too-wide' });
    expect(entry(result, 2)).toEqual({ status: 'not-scored', reason: 'no-gpus' });
    expect(metrics.queries).toHaveLength(0);
  });

  it('does not compute a job that is shorter than the page buckets', async () => {
    // 100 nodes over three days: buckets of about 18 minutes.
    const nodes = Array.from({ length: 100 }, (_, index) => `gpu-node${index}`);
    const long = makeJob(1, { nodes, nodeCount: 100, gpusTotal: 800, endTime: START + 72 * HOUR });
    const short = makeJob(2, { nodes: ['gpu-node0'], startTime: START + 600, endTime: START + 1200 });
    const metrics = new FakeMetrics({ gpus: gpus('gpu-node0', () => 0), scrapeInterval: 300 });

    const result = await fetchJobsIdleGpuBatch([long, short], cluster, NOW, metrics);

    expect(metrics.queries[0].step).toBe(1085);
    expect(entry(result, 2)).toEqual({ status: 'not-computed', reason: 'no-full-bucket', bucketSeconds: 1085 });
  });

  it('scores a job of several weeks with longer buckets', async () => {
    // Eleven days: 499 buckets of 1,905 s.
    const job = makeJob(1, { endTime: START + 11 * 24 * HOUR });
    const metrics = new FakeMetrics({ gpus: gpus('gpu-node001', (index) => (index < 6 ? 90 : 0)), scrapeInterval: 600 });

    const result = await fetchJobsIdleGpuBatch([job], cluster, START + 12 * 24 * HOUR, metrics);

    expect(metrics.queries[0].step).toBe(1905);
    const scored = entry(result, 1);
    expect(scored).toMatchObject({ status: 'ok', unobservedGpuSeconds: 0, sharedNodes: false });
    // Two of eight GPUs idle in every bucket that lies inside the job.
    expect(scored).toMatchObject({ idleGpuSeconds: 2 * 498 * 1905, scoredGpuSeconds: 8 * 498 * 1905 });
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

  it('scores nothing and queries nothing for a cluster that turned job efficiency off', async () => {
    const metrics = new FakeMetrics({ gpus: gpus('gpu-node001', () => 0) });
    const result = await fetchJobsIdleGpuBatch([makeJob(1), makeJob(2, { gpusTotal: 0 })], { ...cluster, efficiency: { disabled: true } }, NOW, metrics);

    expect(result.size).toBe(0);
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
    expect(entry(result, 1)).toEqual({ status: 'ok', idleGpuSeconds: 7 * HOUR, scoredGpuSeconds: 8 * HOUR, unobservedGpuSeconds: 0, sharedNodes: false });
  });
});

describe('planIdleGpuBatch', () => {
  it('keeps nodes x buckets under the point budget and buckets at least a minute long', () => {
    const nodes = Array.from({ length: 100 }, (_, index) => `n${index}`);
    const plan = planIdleGpuBatch([makeJob(1, { nodes, endTime: START + 24 * HOUR }), makeJob(2, { startTime: START - HOUR })], NOW);

    // 25 hours on 101 nodes: 24000 / 101 = 237 buckets, one of them kept for the alignment.
    expect(plan).toMatchObject({ step: 382 });
    expect(plan!.nodes).toHaveLength(101);
    expect(plan!.nodes.length * plan!.buckets).toBeLessThanOrEqual(24_000);
    expect(planIdleGpuBatch([makeJob(1)], NOW)).toMatchObject({ gridStart: START, step: 60, buckets: 60 });
  });

  it('puts the bucket boundaries on multiples of the bucket length and covers every job', () => {
    const jobs = [makeJob(1, { startTime: START + 25, endTime: START + 7 * HOUR + 50 }), makeJob(2, { startTime: START + 3 * HOUR + 7 })];
    const plan = planIdleGpuBatch(jobs, NOW)!;

    expect(plan.gridStart % plan.step).toBe(0);
    expect(plan.gridStart).toBeLessThanOrEqual(START + 25);
    expect(plan.gridStart).toBeGreaterThan(START + 25 - plan.step);
    expect(plan.gridStart + plan.buckets * plan.step).toBeGreaterThanOrEqual(START + 7 * HOUR + 50);
  });

  it('refuses a page whose buckets would be longer than the limit', () => {
    expect(planIdleGpuBatch([makeJob(1, { endTime: START + 499 * MAX_BATCH_STEP_SECONDS })], NOW)).toMatchObject({ step: MAX_BATCH_STEP_SECONDS });
    expect(planIdleGpuBatch([makeJob(1, { endTime: START + 499 * MAX_BATCH_STEP_SECONDS + 1 })], NOW)).toBeNull();
  });
});

describe('sortJobsByIdleGpu', () => {
  it('puts the most idle GPU time first and keeps jobs without a value in their order at the end', () => {
    const jobs = [makeJob(1), makeJob(2), makeJob(3), makeJob(4), makeJob(5)];
    const idle = new Map<string, JobIdleGpu>([
      [jobKey('a100', 1), { status: 'no-data' }],
      [jobKey('a100', 2), { status: 'ok', idleGpuSeconds: 100, scoredGpuSeconds: 1000, unobservedGpuSeconds: 0, sharedNodes: false }],
      [jobKey('a100', 3), { status: 'not-scored', reason: 'no-gpus' }],
      [jobKey('a100', 4), { status: 'ok', idleGpuSeconds: 900, scoredGpuSeconds: 1000, unobservedGpuSeconds: 0, sharedNodes: false }],
    ]);

    expect(sortJobsByIdleGpu(jobs, idle).map((job) => job.jobId)).toEqual([4, 2, 1, 3, 5]);
    // The input order is not changed.
    expect(jobs.map((job) => job.jobId)).toEqual([1, 2, 3, 4, 5]);
  });

  it('ranks a job with zero idle time above jobs without a value', () => {
    const jobs = [makeJob(1), makeJob(2)];
    const idle = new Map<string, JobIdleGpu>([[jobKey('a100', 2), { status: 'ok', idleGpuSeconds: 0, scoredGpuSeconds: 1000, unobservedGpuSeconds: 0, sharedNodes: false }]]);
    expect(sortJobsByIdleGpu(jobs, idle).map((job) => job.jobId)).toEqual([2, 1]);
  });
});

describe('describeJobIdleGpu', () => {
  it.each<[JobIdleGpu | undefined, string, string]>([
    [undefined, '...', 'Scoring idle GPU time'],
    [
      { status: 'ok', idleGpuSeconds: 4 * HOUR, scoredGpuSeconds: 8 * HOUR, unobservedGpuSeconds: 0, sharedNodes: false },
      '≥ 4.0',
      'At least 4.0 GPU-hours idle, 50% of the 8.0 allocated GPU-hours scored.',
    ],
    [
      { status: 'ok', idleGpuSeconds: HOUR, scoredGpuSeconds: 4 * HOUR, unobservedGpuSeconds: 0, sharedNodes: true },
      '≥ 1.0',
      'At least 1.0 GPU-hours idle, 25% of the 4.0 allocated GPU-hours scored. The job shares its nodes, so this counts only GPUs that no job used.',
    ],
    [{ status: 'no-data' }, 'no data', "No GPU telemetry for the job's nodes and time. This does not mean that the GPUs were idle."],
    [{ status: 'not-scored', reason: 'no-gpus' }, '-', 'The job allocated no GPUs.'],
    [{ status: 'not-scored', reason: 'too-short' }, '-', 'The job ran for less than 5 minutes.'],
    [
      { status: 'not-scored', reason: 'suspended' },
      '-',
      'The job was suspended during its run, so its telemetry cannot be scored against its allocation.',
    ],
    [
      { status: 'not-scored', reason: 'past-time-limit' },
      '-',
      'slurmdbd records the job as running long past its time limit. Its end may be missing from the accounting database, so it is not scored.',
    ],
    [
      { status: 'not-computed', reason: 'range-too-wide' },
      'n/c',
      'Not computed. The jobs of this page span too many nodes or too much time to score together. Narrow the time range of the search, or open the job for its efficiency scorecard.',
    ],
    [
      { status: 'not-computed', reason: 'no-full-bucket', bucketSeconds: 1080 },
      'n/c',
      'Not computed. No bucket of this page lies fully inside the job. The jobs of a page share one grid of 18m buckets, from the earliest start to the latest end. Narrow the time range of the search, or open the job for its efficiency scorecard.',
    ],
    [{ status: 'not-computed', reason: 'query-failed' }, 'n/c', 'Not computed. The metrics query failed.'],
    [
      { status: 'ok', idleGpuSeconds: HOUR, scoredGpuSeconds: 8 * HOUR, unobservedGpuSeconds: 2 * HOUR, sharedNodes: false },
      '≥ 1.0',
      'At least 1.0 GPU-hours idle, 13% of the 8.0 allocated GPU-hours scored. 2.0 GPU-hours have no telemetry that belongs to the job and count as neither idle nor active.',
    ],
    [
      { status: 'not-computed', reason: 'nodes-without-telemetry', nodes: ['gpu-node002'] },
      'n/c',
      'Not computed. Node gpu-node002 of the job reports no GPU telemetry, so the GPUs that report cannot be matched to the job.',
    ],
    [
      { status: 'not-computed', reason: 'nodes-without-telemetry', nodes: ['n1', 'n2', 'n3', 'n4'] },
      'n/c',
      'Not computed. Nodes n1, n2, n3 and 1 more of the job report no GPU telemetry, so the GPUs that report cannot be matched to the job.',
    ],
    [
      { status: 'not-computed', reason: 'fewer-gpus-than-allocated' },
      'n/c',
      "Not computed. The job's nodes report fewer GPUs than the job allocated, so the GPUs that report cannot be matched to the job.",
    ],
    [
      { status: 'not-computed', reason: 'incomplete-telemetry' },
      'n/c',
      'Not computed. The job shares its nodes, and in no bucket did every GPU of these nodes report.',
    ],
  ])('describes %j', (value, text, title) => {
    expect(describeJobIdleGpu(value)).toEqual({ text, title });
  });
});
