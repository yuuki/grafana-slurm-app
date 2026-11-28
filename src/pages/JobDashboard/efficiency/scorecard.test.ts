import { ClusterSummary, JobRecord } from '../../../api/types';
import { FakeGpu, FakeMetrics, FakeMetricsOptions, FakeNode } from './__fixtures__/fakeMetrics';
import { MetricsClient } from './promClient';
import { computeJobEfficiency, EfficiencyAborted, JobEfficiency, MAX_QUERIES_PER_SCORECARD, QUERIES_PER_SCORECARD } from './scorecard';
import { POINT_BUDGET } from './window';

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

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    clusterId: 'a100',
    jobId: 4242,
    name: 'train',
    user: 'researcher1',
    account: 'ml-team',
    partition: 'gpu-a100',
    state: 'COMPLETED',
    nodes: ['gpu-node001'],
    nodeList: 'gpu-node001',
    nodeCount: 1,
    gpusTotal: 4,
    cpusTotal: 16,
    submitTime: START - 60,
    startTime: START,
    endTime: START + HOUR,
    exitCode: 0,
    workDir: '/tmp',
    tres: '1=16,1001=4',
    templateId: 'overview',
    ...overrides,
  };
}

const always = (value: number) => () => value;
/** value for scrapes in (from, to], otherwise no scrape. */
const during = (from: number, to: number, value: number) => (time: number) => (time > from && time <= to ? value : undefined);
/** inside for scrapes in (from, to], outside before and after. */
const switching = (from: number, to: number, inside: number, outside: number) => (time: number) =>
  time > from && time <= to ? inside : outside;

/** GPUs 0..count-1 of a node, 80 GiB each. */
function gpus(node: string, count: number, utilization: (index: number) => FakeGpu['utilization'], usedMiB = 60000): FakeGpu[] {
  return Array.from({ length: count }, (_, index) => ({
    instance: `${node}:9400`,
    gpu: String(index),
    utilization: utilization(index),
    usedMiB: always(usedMiB),
    freeMiB: always(81920 - usedMiB),
  }));
}

function node(name: string, busyShare: number, ioWaitShare = 0.01, cpus = 16): FakeNode {
  return { instance: `${name}:9100`, cpus, busyShare: always(busyShare), ioWaitShare: always(ioWaitShare) };
}

async function score(
  options: FakeMetricsOptions,
  job: JobRecord = makeJob(),
  target: ClusterSummary = cluster,
  now = NOW
): Promise<{ result: JobEfficiency; metrics: FakeMetrics }> {
  const metrics = new FakeMetrics(options);
  const result = await computeJobEfficiency({ job, cluster: target, nowSeconds: now, client: metrics });
  return { result, metrics };
}

function expectScored(result: JobEfficiency): Extract<JobEfficiency, { kind: 'scored' }> {
  if (result.kind !== 'scored') {
    throw new Error(`expected a scored job, got ${JSON.stringify(result)}`);
  }
  return result;
}

describe('computeJobEfficiency', () => {
  it('scores a job that uses everything it allocated', async () => {
    const { result, metrics } = await score({ gpus: gpus('gpu-node001', 4, () => always(92)), nodes: [node('gpu-node001', 0.5)] });

    const scored = expectScored(result);
    expect(scored.window).toMatchObject({ buckets: 60, step: 60, running: false, skippedStartSeconds: 0, skippedEndSeconds: 0 });
    expect(scored.gpu).toMatchObject({ attribution: 'exact', observedGpus: 4, activeGpus: 4, neverActiveGpus: 0, timeInUseShare: 1 });
    expect(scored.gpu.time).toEqual({ allocatedSeconds: 4 * HOUR, activeSeconds: 4 * HOUR, idleSeconds: 0, unobservedSeconds: 0, bounded: false });
    expect(scored.memory.status).toBe('ok');
    expect(scored.memory.fullest?.share).toBeCloseTo(60000 / 81920);
    expect(scored.bottleneck).toMatchObject({ status: 'ok', cpuAttribution: 'exclusive', nodeCpus: 16, lowGpuShare: 0 });
    expect(metrics.queries).toHaveLength(QUERIES_PER_SCORECARD);
  });

  it('finds idle GPUs and is not misled by the jobs that ran on them before and after', async () => {
    const job = makeJob({ gpusTotal: 8 });
    const { result } = await score(
      {
        gpus: gpus('gpu-node001', 8, (index) => (index < 4 ? always(85) : switching(job.startTime, job.endTime, 0, 100)), 9000),
        nodes: [node('gpu-node001', 0.4)],
      },
      job
    );

    const scored = expectScored(result);
    expect(scored.gpu).toMatchObject({ attribution: 'exact', activeGpus: 4, idleGpus: 4, neverActiveGpus: 4, peakConcurrentActiveGpus: 4 });
    expect(scored.gpu.time.idleSeconds).toBe(4 * HOUR);
    expect(scored.gpu.timeInUseShare).toBeCloseTo(0.5);
    expect(scored.gpu.gpus.filter((item) => item.activity === 'idle').map((item) => item.gpu)).toEqual(['4', '5', '6', '7']);
    // 9000 MiB of 81920 MiB on every GPU: under the 15% threshold.
    expect(scored.memory.status).toBe('low');
    expect(scored.bottleneck.status).toBe('ok');
  });

  it('selects only the series of the job nodes', async () => {
    const { result } = await score({
      gpus: [...gpus('gpu-node001', 4, () => always(90)), ...gpus('gpu-node002', 4, () => always(0)), ...gpus('gpu-node0011', 4, () => always(0))],
      nodes: [node('gpu-node001', 0.5), node('gpu-node002', 1)],
    });

    const scored = expectScored(result);
    expect(scored.gpu).toMatchObject({ observedGpus: 4, attribution: 'exact', neverActiveGpus: 0 });
    expect(scored.bottleneck.nodeCpus).toBe(16);
  });

  it.each([
    ['a cluster that turned job efficiency off', makeJob(), { ...cluster, efficiency: { disabled: true } }, 'disabled'],
    ['no datasource', makeJob(), { ...cluster, metricsDatasourceUid: '' }, 'no-datasource'],
    ['a pending job', makeJob({ state: 'PENDING', startTime: 0, endTime: 0 }), cluster, 'not-started'],
    ['no GPUs in AllocTRES', makeJob({ gpusTotal: 0, tres: '1=16' }), cluster, 'no-gpus-allocated'],
    ['a job under five minutes', makeJob({ endTime: START + 299 }), cluster, 'too-short'],
    ['a job that was suspended', makeJob({ suspendedSeconds: 600 }), cluster, 'suspended'],
    ['a job that is suspended', makeJob({ state: 'SUSPENDED', endTime: 0 }), cluster, 'suspended'],
    ['a job recorded as running long past its time limit', makeJob({ state: 'RUNNING', endTime: 0, timeLimitSeconds: HOUR }), cluster, 'past-time-limit'],
    ['a job beyond the point budget', makeJob({ gpusTotal: 30000 }), cluster, 'too-large'],
    ['invalid efficiency settings', makeJob(), { ...cluster, efficiency: { gpuUtilizationMetric: 'up{}' } }, 'invalid-settings'],
  ])('does not score and does not query for %s', async (_name, job, target, reason) => {
    const { result, metrics } = await score({ gpus: gpus('gpu-node001', 4, () => always(0)) }, job, target);

    expect(result).toMatchObject({ kind: 'not-computed', reason });
    expect(metrics.queries).toHaveLength(0);
  });

  it('reports the elapsed time of a job that is too short', async () => {
    const { result } = await score({}, makeJob({ endTime: START + 120 }));
    expect(result).toMatchObject({ kind: 'not-computed', reason: 'too-short', value: 120 });
  });

  it('reports how long a job was suspended, and how far a running job is past its time limit', async () => {
    // All four GPUs are idle: without the suspension this would be four idle GPUs.
    const idle = { gpus: gpus('gpu-node001', 4, () => always(0)) };

    expect((await score(idle, makeJob({ suspendedSeconds: 600 }))).result).toMatchObject({ kind: 'not-computed', reason: 'suspended', value: 600 });
    const unknown = (await score(idle, makeJob({ suspendedSeconds: -1 }))).result;
    expect(unknown).toMatchObject({ kind: 'not-computed', reason: 'suspended' });
    expect(unknown).not.toHaveProperty('value', expect.anything());
    // NOW is 100 hours after the start; the limit was one hour.
    expect((await score(idle, makeJob({ state: 'RUNNING', endTime: 0, timeLimitSeconds: HOUR }))).result).toMatchObject({
      kind: 'not-computed',
      reason: 'past-time-limit',
      value: 99 * HOUR,
    });
    // A running job within its limit is scored.
    expect((await score(idle, makeJob({ state: 'RUNNING', endTime: 0, timeLimitSeconds: 200 * HOUR }))).result.kind).toBe('scored');
  });

  it('names the invalid efficiency settings', async () => {
    const { result } = await score({}, makeJob(), { ...cluster, efficiency: { gpuIdLabel: 'a b', lowGpuMemoryPercent: 200 } });
    expect(result).toMatchObject({
      kind: 'not-computed',
      reason: 'invalid-settings',
      errors: ['GPU ID Label must be a Prometheus label name', 'Low GPU Memory (%) must be between 0 and 100'],
    });
  });

  it('reports no telemetry, not idle GPUs, when the nodes have no GPU series', async () => {
    const { result, metrics } = await score({ gpus: gpus('other-node', 4, () => always(0)), nodes: [node('gpu-node001', 0.5)] });

    expect(result.kind).toBe('no-telemetry');
    // Only the two GPU utilization queries ran.
    expect(metrics.queries).toHaveLength(2);
  });

  it('reports no telemetry when the series exist only outside the job', async () => {
    const job = makeJob();
    const { result } = await score({ gpus: gpus('gpu-node001', 4, () => during(job.endTime, job.endTime + HOUR, 90)) });
    expect(result.kind).toBe('no-telemetry');
  });

  it('refuses to score when the GPU ID label is missing, instead of merging the GPUs of a node', async () => {
    const unlabeled = gpus('gpu-node001', 4, () => always(0)).map((item) => ({ ...item, gpu: undefined }));
    const { result } = await score({ gpus: unlabeled });
    expect(result).toMatchObject({ kind: 'not-computed', reason: 'missing-gpu-label' });
  });

  it('matches no GPU to the job when its nodes report fewer GPUs than it allocated', async () => {
    const job = makeJob({ gpusTotal: 8 });
    const half = [...gpus('gpu-node001', 2, () => always(88)), ...gpus('gpu-node001', 4, () => always(0)).slice(2)];
    const { result, metrics } = await score({ gpus: half, nodes: [node('gpu-node001', 0.5)] }, job);

    const scored = expectScored(result);
    // GPUs 2 and 3 are idle, but the job's eight GPUs cannot be told from them.
    expect(scored.gpu).toMatchObject({
      attribution: 'unknown',
      unknownReason: 'fewer-gpus-than-allocated',
      observedGpus: 4,
      neverActiveGpus: 0,
      timeInUseShare: undefined,
    });
    expect(scored.gpu.time).toMatchObject({ activeSeconds: 0, idleSeconds: 0, unobservedSeconds: 8 * HOUR });
    expect(scored.memory).toMatchObject({ status: 'inconclusive', reason: 'unattributed-gpus' });
    expect(scored.bottleneck).toMatchObject({ status: 'inconclusive', reason: 'unattributed-gpus' });
    // The CPU queries are skipped: their outcome could not change the score.
    expect(metrics.queries).toHaveLength(4);
  });

  it('does not take the idle GPUs of a shared node for the job own when another node of the job has no exporter', async () => {
    // The job holds GPUs 0-3 of each node, all busy. gpu-node002 has no
    // exporter. GPUs 4-7 of gpu-node001 are idle and belong to nobody.
    const job = makeJob({ nodes: ['gpu-node001', 'gpu-node002'], nodeCount: 2, gpusTotal: 8, cpusTotal: 32 });
    const { result } = await score({ gpus: gpus('gpu-node001', 8, (index) => always(index < 4 ? 95 : 0)), nodes: [node('gpu-node001', 0.5)] }, job);

    const scored = expectScored(result);
    // The eight GPUs that report are as many as the job allocated, and still not the job's.
    expect(scored.gpu).toMatchObject({
      attribution: 'unknown',
      unknownReason: 'silent-nodes',
      silentNodes: ['gpu-node002'],
      observedGpus: 8,
      neverActiveGpus: 0,
      peakConcurrentActiveGpus: undefined,
    });
    expect(scored.gpu.time).toEqual({ allocatedSeconds: 8 * HOUR, activeSeconds: 0, idleSeconds: 0, unobservedSeconds: 8 * HOUR, bounded: false });
    expect(scored.memory).toMatchObject({ status: 'inconclusive', reason: 'unattributed-gpus' });
    expect(scored.bottleneck).toMatchObject({ status: 'inconclusive', reason: 'unattributed-gpus' });
  });

  it('gives no lower bound for idle GPUs when a node of the job has no exporter and the other is shared', async () => {
    // The job holds two busy GPUs on each node; gpu-node002 has no exporter.
    const job = makeJob({ nodes: ['gpu-node001', 'gpu-node002'], nodeCount: 2, gpusTotal: 4 });
    const { result } = await score({ gpus: gpus('gpu-node001', 8, (index) => always(index < 2 ? 95 : 0)) }, job);

    const scored = expectScored(result);
    expect(scored.gpu).toMatchObject({ attribution: 'unknown', silentNodes: ['gpu-node002'], neverActiveGpus: 0 });
    expect(scored.gpu.time.idleSeconds).toBe(0);
  });

  it('counts no idle GPU time on shared nodes while the exporter of one node is down', async () => {
    // The job holds GPUs 0-3 of each node, busy all the time. GPUs 4-7 of
    // both nodes are idle and not the job's. The exporter of gpu-node002
    // stops after half an hour.
    const job = makeJob({ nodes: ['gpu-node001', 'gpu-node002'], nodeCount: 2, gpusTotal: 8 });
    const { result } = await score(
      {
        gpus: [
          ...gpus('gpu-node001', 8, (index) => always(index < 4 ? 95 : 0)),
          ...gpus('gpu-node002', 8, (index) => during(START - HOUR, START + HOUR / 2, index < 4 ? 95 : 0)),
        ],
      },
      job
    );

    const scored = expectScored(result);
    expect(scored.gpu).toMatchObject({ attribution: 'shared', observedGpus: 16, activeGpus: 8, neverActiveGpus: 0, completeBuckets: 30 });
    // In the second half only gpu-node001 reports: eight GPUs, as many as
    // the job allocated, four of them idle. They are not the job's.
    expect(scored.gpu.time).toEqual({ allocatedSeconds: 8 * HOUR, activeSeconds: 4 * HOUR, idleSeconds: 0, unobservedSeconds: 4 * HOUR, bounded: true });
  });

  it('counts no idle GPU time on shared nodes that are never scraped in the same bucket', async () => {
    // One scrape every two minutes, the two nodes one minute apart: each
    // one-minute bucket holds the eight GPUs of one node only.
    const every2Minutes = (phase: number, value: number) => (time: number) => (time % 120 === phase ? value : undefined);
    const job = makeJob({ nodes: ['gpu-node001', 'gpu-node002'], nodeCount: 2, gpusTotal: 8 });
    const { result } = await score(
      {
        gpus: [
          ...gpus('gpu-node001', 8, (index) => every2Minutes(30, index < 4 ? 95 : 0)),
          ...gpus('gpu-node002', 8, (index) => every2Minutes(90, index < 4 ? 95 : 0)),
        ],
      },
      job
    );

    const scored = expectScored(result);
    expect(scored.gpu).toMatchObject({ attribution: 'shared', activeGpus: 8, idleGpus: 0, partialGpus: 8, neverActiveGpus: 0, completeBuckets: 0 });
    expect(scored.gpu.time).toEqual({ allocatedSeconds: 8 * HOUR, activeSeconds: 0, idleSeconds: 0, unobservedSeconds: 8 * HOUR, bounded: true });
  });

  it('counts the part of a job without telemetry as unobserved (metrics retention)', async () => {
    const job = makeJob({ endTime: START + 2 * HOUR });
    const { result } = await score({
      gpus: gpus('gpu-node001', 4, (index) => during(START + HOUR, START + 2 * HOUR, index === 3 ? 0 : 90)),
      nodes: [node('gpu-node001', 0.5)],
    }, job);

    const scored = expectScored(result);
    expect(scored.gpu.completeBuckets).toBe(60);
    expect(scored.window.buckets).toBe(120);
    expect(scored.gpu.time).toEqual({
      allocatedSeconds: 8 * HOUR,
      activeSeconds: 3 * HOUR,
      idleSeconds: 1 * HOUR,
      unobservedSeconds: 4 * HOUR,
      bounded: false,
    });
    // GPU 3 was idle for all of the observed hour, but what it did in the first hour is unknown.
    expect(scored.gpu).toMatchObject({ idleGpus: 0, partialGpus: 1, neverActiveGpus: 0 });
  });

  it('scores the elapsed part of a running job up to two minutes ago', async () => {
    const now = START + 40 * 60;
    const job = makeJob({ state: 'RUNNING', endTime: 0 });
    // The scrapes of the newest two minutes have not arrived yet.
    const arrived = await score(
      { gpus: gpus('gpu-node001', 4, (index) => during(START - HOUR, now - 120, index === 3 ? 0 : 95)), nodes: [node('gpu-node001', 0.5)] },
      job,
      cluster,
      now
    );

    const scored = expectScored(arrived.result);
    expect(scored.window).toMatchObject({ running: true, runningLagSeconds: 120, gridEnd: now - 120, buckets: 38 });
    // The telemetry is complete up to the end of the window, so the idle GPU is known to be idle.
    expect(scored.gpu).toMatchObject({ completeBuckets: 38, idleGpus: 1, neverActiveGpus: 1 });
    expect(scored.gpu.time.unobservedSeconds).toBe(0);
    expect(arrived.metrics.queries.every((query) => query.end <= now - 120)).toBe(true);

    // With five minutes missing, the last three buckets have no telemetry.
    const late = await score(
      { gpus: gpus('gpu-node001', 4, () => during(START - HOUR, now - 300, 95)), nodes: [node('gpu-node001', 0.5)] },
      job,
      cluster,
      now
    );
    const gappy = expectScored(late.result);
    expect(gappy.gpu.completeBuckets).toBe(35);
    expect(gappy.gpu.time.unobservedSeconds).toBe(4 * 3 * 60);
    expect(gappy.gpu.neverActiveGpus).toBe(0);
  });

  it('gives lower bounds on nodes that report more GPUs than the job allocated', async () => {
    const job = makeJob({ gpusTotal: 6, cpusTotal: 12 });
    const { result, metrics } = await score({
      gpus: gpus('gpu-node001', 8, (index) => always(index === 0 ? 70 : 0), 30000),
      nodes: [node('gpu-node001', 0.2)],
    }, job);

    const scored = expectScored(result);
    expect(scored.gpu).toMatchObject({ attribution: 'shared', observedGpus: 8, activeGpus: 1, neverActiveGpus: 5 });
    expect(scored.gpu.time).toEqual({ allocatedSeconds: 6 * HOUR, activeSeconds: HOUR, idleSeconds: 5 * HOUR, unobservedSeconds: 0, bounded: true });
    expect(scored.memory).toMatchObject({ status: 'inconclusive', reason: 'shared-gpus' });
    expect(scored.bottleneck).toMatchObject({ status: 'inconclusive', reason: 'shared-gpus' });
    // The CPU queries are skipped: their outcome could not change the score.
    expect(metrics.queries).toHaveLength(4);
  });

  it('reads GPU memory per bucket and does not report low memory when the telemetry has a gap', async () => {
    // 9000 MiB of 81920 MiB is low, but the memory metrics report in the second half hour only.
    const withGap = gpus('gpu-node001', 4, () => always(90), 9000).map((item) => ({
      ...item,
      usedMiB: during(START + HOUR / 2, START + 2 * HOUR, 9000),
      freeMiB: during(START + HOUR / 2, START + 2 * HOUR, 72920),
    }));
    const { result, metrics } = await score({ gpus: withGap, nodes: [node('gpu-node001', 0.5)] });

    const { memory } = expectScored(result);
    // The peak may lie in the half hour without memory telemetry.
    expect(memory).toMatchObject({ status: 'inconclusive', reason: 'incomplete-data', gpusWithCapacity: 4, gpusCovered: 0 });
    expect(memory.fullest?.share).toBeCloseTo(9000 / 81920);
    // One evaluation reads the samples of one bucket, not of the whole job.
    for (const query of metrics.queries.filter((item) => /FB_(USED|FREE)/.test(item.expr))) {
      expect(query).toMatchObject({ kind: 'range', start: START + 60, end: START + HOUR, step: 60 });
      expect(query.expr).toContain('[60s]');
    }
  });

  it('skips the CPU queries when no GPU was active', async () => {
    const { result, metrics } = await score({ gpus: gpus('gpu-node001', 4, () => always(0), 3), nodes: [node('gpu-node001', 0.9)] });

    const scored = expectScored(result);
    expect(scored.gpu).toMatchObject({ idleGpus: 4, neverActiveGpus: 4, timeInUseShare: 0 });
    expect(scored.memory.status).toBe('not-applicable');
    expect(scored.bottleneck).toMatchObject({ status: 'not-applicable', reason: 'no-active-gpu' });
    expect(metrics.queries).toHaveLength(4);
  });

  it('reports a CPU-bound input pipeline', async () => {
    const { result } = await score({ gpus: gpus('gpu-node001', 4, () => always(30)), nodes: [node('gpu-node001', 0.97, 0.005)] });

    const { bottleneck } = expectScored(result);
    expect(bottleneck).toMatchObject({ status: 'cpu-bound', cpuAttribution: 'exclusive', lowGpuShare: 1, cpuStarvedShare: 1, ioStarvedShare: 0 });
    expect(bottleneck.meanBusyCpusWhileLow).toBeCloseTo(15.52);
    expect(bottleneck.meanGpuUtilizationWhileLow).toBeCloseTo(30);
  });

  it('reports an I/O-bound input pipeline and does not count waiting CPUs as busy', async () => {
    const { result } = await score({ gpus: gpus('gpu-node001', 4, () => always(25)), nodes: [node('gpu-node001', 0.3, 0.2)] });

    const { bottleneck } = expectScored(result);
    expect(bottleneck).toMatchObject({ status: 'io-bound', cpuStarvedShare: 0, ioStarvedShare: 1 });
    expect(bottleneck.meanBusyCpusWhileLow).toBeCloseTo(4.8);
    expect(bottleneck.meanIoWaitCpusWhileLow).toBeCloseTo(3.2);
  });

  it('does not read the CPU time of the job that ran on the node before', async () => {
    // Until the job starts, 60% of the CPU time waits for I/O. The job itself
    // waits for nothing: 20% of its CPUs are busy and its GPUs run at 30%.
    const job = makeJob({ startTime: START + 37, endTime: START + 37 + 600 });
    const before = (time: number) => time <= job.startTime;
    const { result, metrics } = await score(
      {
        gpus: gpus('gpu-node001', 4, () => switching(job.startTime, job.endTime, 30, 0)),
        nodes: [
          {
            instance: 'gpu-node001:9100',
            cpus: 16,
            busyShare: (time) => (before(time) ? 0.05 : 0.2),
            ioWaitShare: (time) => (before(time) ? 0.6 : 0),
          },
        ],
      },
      job
    );

    const { bottleneck } = expectScored(result);
    expect(bottleneck).toMatchObject({ status: 'ok', lowGpuShare: 1, cpuStarvedShare: 0, ioStarvedShare: 0, ioStarvedShareMax: 0 });
    expect(bottleneck.meanIoWaitCpusWhileLow).toBeCloseTo(0);
    expect(bottleneck.meanBusyCpusWhileLow).toBeCloseTo(3.2);
    // Every five-minute window of the CPU and GPU readings starts inside the job.
    const windowQueries = metrics.queries.filter((query) => query.expr.includes('[300s]'));
    expect(windowQueries).toHaveLength(4);
    for (const query of windowQueries) {
      expect(query.start - 300).toBeGreaterThanOrEqual(job.startTime);
      expect(query.end).toBeLessThanOrEqual(job.endTime);
    }
  });

  it('does not take the saturated CPUs of the job before for a CPU bottleneck of a short job', async () => {
    // Seven minutes: one window. All CPUs busy until the job starts, 75% of them during the job.
    const job = makeJob({ startTime: START + 37, endTime: START + 37 + 420 });
    const { result } = await score(
      {
        gpus: gpus('gpu-node001', 4, () => switching(job.startTime, job.endTime, 30, 0)),
        nodes: [{ instance: 'gpu-node001:9100', cpus: 16, busyShare: (time) => (time <= job.startTime ? 1 : 0.75), ioWaitShare: always(0) }],
      },
      job
    );

    const { bottleneck } = expectScored(result);
    expect(bottleneck).toMatchObject({ status: 'ok', windows: 1, scoredWindows: 1, cpuStarvedShare: 0 });
    expect(bottleneck.meanBusyCpusWhileLow).toBeCloseTo(12);
  });

  it('reads the CPU load in five-minute windows that follow each other inside the job', async () => {
    const { result, metrics } = await score({ gpus: gpus('gpu-node001', 4, () => always(30)), nodes: [node('gpu-node001', 0.97, 0.005)] });

    const { bottleneck } = expectScored(result);
    // START is 240 s after a multiple of 300: the first window ends at START + 360.
    expect(bottleneck).toMatchObject({ windows: 11, scoredWindows: 11, unscoredWindows: 0, ioScoredWindows: 11 });
    expect(bottleneck.coverage).toBeCloseTo(3300 / 3600);
    for (const query of metrics.queries.slice(4)) {
      expect(query).toMatchObject({ kind: 'range', start: START + 360, end: START + 3360, step: 300 });
    }
  });

  it('does not judge the CPUs of a job when one of its nodes has no CPU telemetry', async () => {
    // The job holds both nodes. gpu-node001 is saturated; gpu-node002 has no node exporter.
    const job = makeJob({ nodes: ['gpu-node001', 'gpu-node002'], nodeCount: 2, gpusTotal: 8, cpusTotal: 32 });
    const { result } = await score(
      {
        gpus: [...gpus('gpu-node001', 4, () => always(30)), ...gpus('gpu-node002', 4, () => always(30))],
        nodes: [node('gpu-node001', 0.99, 0)],
      },
      job
    );

    const scored = expectScored(result);
    expect(scored.gpu.attribution).toBe('exact');
    expect(scored.bottleneck).toMatchObject({ status: 'inconclusive', reason: 'silent-cpu-nodes', silentNodes: ['gpu-node002'], scoredWindows: 0 });
  });

  it('counts the windows in which the node exporter did not report as unknown', async () => {
    // Saturated CPUs in the first half hour, no CPU telemetry in the second.
    const outage: FakeNode = { instance: 'gpu-node001:9100', cpus: 16, busyShare: during(START - HOUR, START + HOUR / 2, 0.97), ioWaitShare: always(0) };
    const starved = expectScored((await score({ gpus: gpus('gpu-node001', 4, () => always(30)), nodes: [outage] })).result).bottleneck;
    // Six of eleven windows are starved for sure (the sixth holds the last scrapes):
    // a bottleneck whatever the other five were.
    expect(starved).toMatchObject({ status: 'cpu-bound', windows: 11, scoredWindows: 6, unscoredWindows: 5 });
    expect(starved.cpuStarvedShare).toBeCloseTo(6 / 11);
    expect(starved.cpuStarvedShareMax).toBe(1);

    // Half-idle CPUs in the first half hour prove nothing about the second.
    const calm = expectScored(
      (await score({ gpus: gpus('gpu-node001', 4, () => always(30)), nodes: [{ ...outage, busyShare: during(START - HOUR, START + HOUR / 2, 0.5) }] })).result
    ).bottleneck;
    expect(calm).toMatchObject({ status: 'inconclusive', reason: 'incomplete-telemetry', cpuStarvedShare: 0 });
    expect(calm.cpuStarvedShareMax).toBeCloseTo(5 / 11);
  });

  it('does not score a window in which only some CPUs of a node report', async () => {
    // Half of the CPUs stop reporting after half an hour; the ones that report are saturated.
    const partial: FakeNode = {
      instance: 'gpu-node001:9100',
      cpus: 16,
      busyShare: always(0.97),
      ioWaitShare: always(0),
      reportingCpus: (time) => (time > START + HOUR / 2 ? 8 : 16),
    };
    const { bottleneck } = expectScored((await score({ gpus: gpus('gpu-node001', 4, () => always(30)), nodes: [partial] })).result);

    expect(bottleneck).toMatchObject({ status: 'cpu-bound', nodeCpus: 16, cpuAttribution: 'exclusive', scoredWindows: 5, unscoredWindows: 6 });
  });

  it('ignores a GPU series of another node in the window readings', async () => {
    // A backend answers the five-minute GPU query with one series too many:
    // a GPU of a node that is not the job's.
    const metrics = new FakeMetrics({ gpus: gpus('gpu-node001', 4, () => always(30)), nodes: [node('gpu-node001', 0.5)] });
    const client: MetricsClient = {
      instant: (expr, time) => metrics.instant(expr, time),
      range: async (expr, start, end, step) => {
        const series = await metrics.range(expr, start, end, step);
        if (!expr.startsWith('avg by (instance, gpu) (avg_over_time(DCGM_FI_DEV_GPU_UTIL') || !expr.includes('[300s]')) {
          return series;
        }
        return [...series, { metric: { instance: 'other-node:9400', gpu: '0' }, values: series[0].values.map(([time]) => [time, 0] as [number, number]) }];
      },
    };

    const result = await computeJobEfficiency({ job: makeJob(), cluster, nowSeconds: NOW, client });

    // Five GPUs in a window of a job with four would be "incomplete telemetry".
    expect(expectScored(result).bottleneck).toMatchObject({ status: 'ok', scoredWindows: 11, unscoredWindows: 0 });
  });

  it('adds up the CPU series of two exporter instances of one node', async () => {
    // Two instances on gpu-node001, each with eight CPUs: sixteen CPUs, which the job holds.
    const half = (port: number, busyShare: number): FakeNode => ({ ...node('gpu-node001', busyShare, 0, 8), instance: `gpu-node001:${port}` });
    const { result } = await score({ gpus: gpus('gpu-node001', 4, () => always(30)), nodes: [half(9100, 1), half(9101, 0.9)] });

    const { bottleneck } = expectScored(result);
    expect(bottleneck).toMatchObject({ status: 'cpu-bound', nodeCpus: 16, cpuAttribution: 'exclusive', silentNodes: [] });
    // 8 busy CPUs of the first instance and 7.2 of the second.
    expect(bottleneck.meanBusyCpusWhileLow).toBeCloseTo(15.2);
  });

  it('does not blame the job for busy CPUs on a node it shares', async () => {
    const job = makeJob({ cpusTotal: 8 });
    const { result } = await score({ gpus: gpus('gpu-node001', 4, () => always(30)), nodes: [node('gpu-node001', 0.95, 0)] }, job);

    expect(expectScored(result).bottleneck).toMatchObject({ status: 'inconclusive', reason: 'shared-cpus', cpuAttribution: 'shared', nodeCpus: 16 });
  });

  it('is inconclusive about the CPUs when AllocTRES records no CPU count', async () => {
    const job = makeJob({ cpusTotal: undefined });
    const { result } = await score({ gpus: gpus('gpu-node001', 4, () => always(30)), nodes: [node('gpu-node001', 0.95, 0)] }, job);

    expect(expectScored(result).bottleneck).toMatchObject({ status: 'inconclusive', reason: 'cpu-allocation-unknown' });
  });

  it('reports missing CPU and I/O wait telemetry as such', async () => {
    const lowGpus = gpus('gpu-node001', 4, () => always(30));
    const withoutNode = await score({ gpus: lowGpus });
    expect(expectScored(withoutNode.result).bottleneck.status).toBe('no-data');

    const withoutIoWait = await score({ gpus: lowGpus, nodes: [{ instance: 'gpu-node001:9100', cpus: 16, busyShare: always(0.3) }] });
    expect(expectScored(withoutIoWait.result).bottleneck).toMatchObject({ status: 'inconclusive', reason: 'no-io-wait-data' });
  });

  it('keeps the GPU scores when the memory or the CPU queries fail', async () => {
    const options = { gpus: gpus('gpu-node001', 4, () => always(30)), nodes: [node('gpu-node001', 0.97)] };

    const memoryFailure = expectScored((await score({ ...options, failOn: /FB_USED/ })).result);
    expect(memoryFailure.memory).toMatchObject({ status: 'failed', error: 'Metrics query failed (HTTP 500: fake failure)' });
    expect(memoryFailure.gpu.activeGpus).toBe(4);
    expect(memoryFailure.bottleneck.status).toBe('cpu-bound');

    const cpuFailure = expectScored((await score({ ...options, failOn: /node_cpu_seconds_total/ })).result);
    expect(cpuFailure.bottleneck).toMatchObject({ status: 'failed', error: 'Metrics query failed (HTTP 500: fake failure)' });
    expect(cpuFailure.memory.status).toBe('ok');
  });

  it('fails as a whole when the GPU utilization query fails', async () => {
    const metrics = new FakeMetrics({ gpus: gpus('gpu-node001', 4, () => always(30)), failOn: /GPU_UTIL/ });
    await expect(computeJobEfficiency({ job: makeJob(), cluster, nowSeconds: NOW, client: metrics })).rejects.toThrow(
      'Metrics query failed (HTTP 500: fake failure)'
    );
  });

  it('follows the cluster settings: metric names, labels, thresholds and hostname matching', async () => {
    const target: ClusterSummary = {
      ...cluster,
      instanceLabel: 'Hostname',
      nodeMatcherMode: 'hostname',
      efficiency: {
        gpuUtilizationMetric: 'nvidia_gpu_utilization',
        gpuMemoryUsedMetric: 'nvidia_gpu_memory_used',
        gpuMemoryFreeMetric: 'nvidia_gpu_memory_free',
        gpuIdLabel: 'minor_number',
        idleGpuUtilizationPercent: 20,
        lowGpuMemoryPercent: 80,
      },
    };
    const { result } = await score(
      {
        instanceLabel: 'Hostname',
        gpuLabel: 'minor_number',
        utilizationMetric: 'nvidia_gpu_utilization',
        usedMetric: 'nvidia_gpu_memory_used',
        freeMetric: 'nvidia_gpu_memory_free',
        // 15% utilization is idle against a 20% baseline.
        gpus: gpus('gpu-node001', 4, (index) => always(index === 0 ? 90 : 15)).map((item) => ({ ...item, instance: 'gpu-node001' })),
        nodes: [{ ...node('gpu-node001', 0.5), instance: 'gpu-node001' }],
      },
      makeJob(),
      target
    );

    const scored = expectScored(result);
    expect(scored.gpu).toMatchObject({ activeGpus: 1, idleGpus: 3, neverActiveGpus: 3 });
    expect(scored.gpu.gpus[0]).toMatchObject({ instance: 'gpu-node001', node: 'gpu-node001' });
    // 73% of the memory is under the configured 80%.
    expect(scored.memory.status).toBe('low');
  });

  it('scores only the samples inside the job when it starts and ends off the bucket grid', async () => {
    // The job starts 25 s and ends 50 s after a full minute. The GPUs are
    // busy before and after it and idle while it runs.
    const job = makeJob({ startTime: START + 25, endTime: START + HOUR + 50 });
    const { result, metrics } = await score(
      { gpus: gpus('gpu-node001', 4, () => switching(job.startTime, job.endTime, 0, 100), 3), nodes: [node('gpu-node001', 0.1)] },
      job
    );

    const scored = expectScored(result);
    expect(scored.window).toMatchObject({ gridStart: START + 60, gridEnd: START + HOUR, buckets: 59, skippedStartSeconds: 35, skippedEndSeconds: 50 });
    expect(scored.gpu).toMatchObject({ activeGpus: 0, idleGpus: 4, neverActiveGpus: 4 });
    expect(scored.gpu.time.idleSeconds).toBe(4 * 59 * 60);
    expect(metrics.queries[0]).toMatchObject({ start: START + 120, end: START + HOUR, step: 60 });
  });

  it('strips the exporter port from the node name in host:port mode', async () => {
    const { result } = await score({ gpus: gpus('gpu-node001', 4, () => always(90)) });
    expect(expectScored(result).gpu.gpus[0]).toMatchObject({ instance: 'gpu-node001:9400', node: 'gpu-node001' });
  });

  it('sends at most eight queries, one at a time', async () => {
    const metrics = new FakeMetrics({ gpus: gpus('gpu-node001', 4, () => always(30)), nodes: [node('gpu-node001', 0.5)] });
    let inFlight = 0;
    let mostInFlight = 0;
    const track = async <T,>(run: () => Promise<T>): Promise<T> => {
      inFlight++;
      mostInFlight = Math.max(mostInFlight, inFlight);
      // Let any query started in parallel show up before this one settles.
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        return await run();
      } finally {
        inFlight--;
      }
    };
    const client: MetricsClient = {
      instant: (expr, time) => track(() => metrics.instant(expr, time)),
      range: (expr, start, end, step) => track(() => metrics.range(expr, start, end, step)),
    };

    await computeJobEfficiency({ job: makeJob(), cluster, nowSeconds: NOW, client });

    expect(mostInFlight).toBe(1);
    expect(metrics.queries).toHaveLength(QUERIES_PER_SCORECARD);
    expect(metrics.queries.map((query) => query.kind)).toEqual(new Array(QUERIES_PER_SCORECARD).fill('range'));
  });

  it('asks for one point per bucket and never for more points than the budget', async () => {
    const nodes = Array.from({ length: 40 }, (_, index) => `gpu-node${String(index + 1).padStart(3, '0')}`);
    const job = makeJob({ nodes, nodeCount: 40, gpusTotal: 320, cpusTotal: 640, endTime: START + 72 * HOUR });
    const { result, metrics } = await score(
      { gpus: nodes.flatMap((name) => gpus(name, 8, () => always(90))), nodes: nodes.map((name) => node(name, 0.5)), scrapeInterval: 300 },
      job
    );

    const scored = expectScored(result);
    // 24000 points / 320 GPUs = 75 buckets of 3456 s; the alignment can cost one.
    expect(scored.window.step).toBe(3456);
    expect(scored.window.buckets).toBeGreaterThanOrEqual(74);
    expect(scored.window.buckets).toBeLessThanOrEqual(75);
    expect(scored.gpu).toMatchObject({ observedGpus: 320, attribution: 'exact', neverActiveGpus: 0 });
    for (const query of metrics.queries.filter((item) => item.kind === 'range')) {
      expect(query.step).toBe(3456);
      expect((query.end - query.start) / query.step + 1).toBe(scored.window.buckets);
      // Every evaluation time is a multiple of the step.
      expect(query.start % query.step).toBe(0);
    }
  });
  it('plans again with the true number of GPU series when the nodes report more than estimated', async () => {
    // 100 nodes of 16 GPUs, of which the job holds one each: 1,600 series
    // where 800 are estimated (8 per node).
    const nodes = Array.from({ length: 100 }, (_, index) => `gpu-node${String(index + 1).padStart(3, '0')}`);
    const job = makeJob({ nodes, nodeCount: 100, gpusTotal: 100, cpusTotal: 400, endTime: START + 24 * HOUR });
    const metrics = new FakeMetrics({
      scrapeInterval: 600,
      gpus: nodes.flatMap((name) => Array.from({ length: 16 }, (_, index) => ({ instance: `${name}:9400`, gpu: String(index), utilization: always(50) }))),
    });
    const points: number[] = [];
    const client: MetricsClient = {
      instant: (expr, time) => metrics.instant(expr, time),
      range: async (expr, start, end, step) => {
        const series = await metrics.range(expr, start, end, step);
        points.push(series.reduce((sum, item) => sum + item.values.length, 0));
        return series;
      },
    };

    const result = await computeJobEfficiency({ job, cluster, nowSeconds: NOW, client });

    const scored = expectScored(result);
    expect(scored.gpu).toMatchObject({ observedGpus: 1600, attribution: 'shared' });
    // The first query is sent again on buckets twice as long: 15 instead of 30.
    expect(metrics.queries[0]).toMatchObject({ step: 2880 });
    expect(metrics.queries[1]).toMatchObject({ expr: metrics.queries[0].expr.replace('[2880s]', '[5760s]'), step: 5760 });
    expect(scored.window).toMatchObject({ step: 5760 });
    expect(scored.window.buckets).toBeLessThanOrEqual(15);
    // Only the first response exceeds the budget.
    expect(points[0]).toBeGreaterThan(POINT_BUDGET);
    for (const count of points.slice(1)) {
      expect(count).toBeLessThanOrEqual(POINT_BUDGET);
    }
    expect(metrics.queries.length).toBeLessThanOrEqual(MAX_QUERIES_PER_SCORECARD);
  });

  it('does not score a job whose nodes report more GPU series than one scorecard reads', async () => {
    const queries: string[] = [];
    const client: MetricsClient = {
      instant: async () => [],
      range: async (expr) => {
        queries.push(expr);
        return Array.from({ length: POINT_BUDGET + 1 }, (_, index) => ({ metric: { instance: 'gpu-node001:9400', gpu: String(index) }, values: [] }));
      },
    };

    const result = await computeJobEfficiency({ job: makeJob(), cluster, nowSeconds: NOW, client });

    expect(result).toMatchObject({ kind: 'not-computed', reason: 'too-large', value: POINT_BUDGET + 1 });
    expect(queries).toHaveLength(1);
  });

  it('sends no further query once the caller has aborted', async () => {
    for (const abortAfter of [1, 2, 3, 5, 7]) {
      const metrics = new FakeMetrics({ gpus: gpus('gpu-node001', 4, () => always(30)), nodes: [node('gpu-node001', 0.5)] });
      const controller = new AbortController();
      const client: MetricsClient = {
        instant: (expr, time) => metrics.instant(expr, time),
        range: async (expr, start, end, step) => {
          const series = await metrics.range(expr, start, end, step);
          if (metrics.queries.length === abortAfter) {
            controller.abort();
          }
          return series;
        },
      };

      // Also while the memory or the CPU queries run, which otherwise fail softly.
      await expect(computeJobEfficiency({ job: makeJob(), cluster, nowSeconds: NOW, client, signal: controller.signal })).rejects.toBeInstanceOf(
        EfficiencyAborted
      );
      expect(metrics.queries).toHaveLength(abortAfter);
    }
  });

  it('sends no query at all for a signal that is already aborted', async () => {
    const metrics = new FakeMetrics({ gpus: gpus('gpu-node001', 4, () => always(30)) });
    const controller = new AbortController();
    controller.abort();

    await expect(computeJobEfficiency({ job: makeJob(), cluster, nowSeconds: NOW, client: metrics, signal: controller.signal })).rejects.toThrow(
      'Job efficiency scoring was cancelled'
    );
    expect(metrics.queries).toHaveLength(0);
  });
});
