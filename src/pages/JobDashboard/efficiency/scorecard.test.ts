import { ClusterSummary, JobRecord } from '../../../api/types';
import { FakeGpu, FakeMetrics, FakeMetricsOptions, FakeNode } from './__fixtures__/fakeMetrics';
import { MetricsClient } from './promClient';
import { computeJobEfficiency, JobEfficiency, MAX_QUERIES_PER_SCORECARD } from './scorecard';

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
    expect(metrics.queries).toHaveLength(MAX_QUERIES_PER_SCORECARD);
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
    ['no datasource', makeJob(), { ...cluster, metricsDatasourceUid: '' }, 'no-datasource'],
    ['a pending job', makeJob({ state: 'PENDING', startTime: 0, endTime: 0 }), cluster, 'not-started'],
    ['no GPUs in AllocTRES', makeJob({ gpusTotal: 0, tres: '1=16' }), cluster, 'no-gpus-allocated'],
    ['a job under five minutes', makeJob({ endTime: START + 299 }), cluster, 'too-short'],
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

  it('keeps allocated GPUs without telemetry out of the idle count', async () => {
    const job = makeJob({ gpusTotal: 8 });
    const half = gpus('gpu-node001', 4, () => always(88)).map((item) => ({ ...item, freeMiB: undefined }));
    const { result } = await score({ gpus: half, nodes: [node('gpu-node001', 0.5)] }, job);

    const scored = expectScored(result);
    expect(scored.gpu).toMatchObject({ attribution: 'partial', observedGpus: 4, missingGpus: 4, neverActiveGpus: 0, timeInUseShare: 1 });
    expect(scored.gpu.time).toMatchObject({ activeSeconds: 4 * HOUR, idleSeconds: 0, unobservedSeconds: 4 * HOUR });
    expect(scored.memory).toMatchObject({ status: 'capacity-unknown', highestPeakMiB: 60000 });
  });

  it('counts the part of a job without telemetry as unobserved (metrics retention)', async () => {
    const job = makeJob({ endTime: START + 2 * HOUR });
    const { result } = await score({
      gpus: gpus('gpu-node001', 4, (index) => during(START + HOUR, START + 2 * HOUR, index === 3 ? 0 : 90)),
      nodes: [node('gpu-node001', 0.5)],
    }, job);

    const scored = expectScored(result);
    expect(scored.gpu.observedBuckets).toBe(60);
    expect(scored.window.buckets).toBe(120);
    expect(scored.gpu.time).toEqual({
      allocatedSeconds: 8 * HOUR,
      activeSeconds: 3 * HOUR,
      idleSeconds: 1 * HOUR,
      unobservedSeconds: 4 * HOUR,
      bounded: false,
    });
    // GPU 3 was idle for all of the observed hour.
    expect(scored.gpu).toMatchObject({ idleGpus: 1, neverActiveGpus: 1 });
  });

  it('scores the elapsed part of a running job up to now', async () => {
    const now = START + 40 * 60;
    const job = makeJob({ state: 'RUNNING', endTime: 0 });
    // The newest five minutes are not scraped yet.
    const { result, metrics } = await score(
      { gpus: gpus('gpu-node001', 4, () => during(START - HOUR, now - 300, 95)), nodes: [node('gpu-node001', 0.5)] },
      job,
      cluster,
      now
    );

    const scored = expectScored(result);
    expect(scored.window).toMatchObject({ running: true, gridEnd: now, buckets: 40 });
    expect(scored.gpu.observedBuckets).toBe(35);
    expect(scored.gpu.time.unobservedSeconds).toBe(4 * 5 * 60);
    expect(scored.gpu.neverActiveGpus).toBe(0);
    expect(metrics.queries.every((query) => query.end === now)).toBe(true);
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

  it('sends at most seven queries, one at a time', async () => {
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
    expect(metrics.queries).toHaveLength(MAX_QUERIES_PER_SCORECARD);
    expect(metrics.queries.map((query) => query.kind)).toEqual(['range', 'range', 'instant', 'instant', 'range', 'range', 'range']);
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
});
