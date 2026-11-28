import type { ClusterSummary, JobRecord } from '../../../api/types';
import { analyzeJobPhases, JobPhasesAnalysis, JobPhasesOutcome, PhaseAnalysisAborted, PhaseQueryFailed, rateWindow } from './collect';
import { MAX_NODES, POINT_BUDGET } from './plan';
import { MetricsClient, MetricsQueryError, PromInstantSample, PromRangeSeries } from './promClient';
import { EffectivePhaseSettings, resolvePhaseSettings } from './settings';
import { PhaseId } from './types';
import { createFakeMetricsClient, FakeMetricsClient } from './__fixtures__/fakeMetrics';
import { generateSyntheticJob, SyntheticJob, SyntheticJobSpec, SyntheticStage, syntheticSpec } from './__fixtures__/syntheticJob';

const MINUTE = 60;

function stage(phase: SyntheticStage['phase'], minutes: number): SyntheticStage {
  return { phase, seconds: minutes * MINUTE };
}

const STAGES: SyntheticStage[] = [stage('init', 6), stage('compute', 30), stage('checkpoint', 3), stage('compute', 30), stage('stalled', 20)];

const settings: EffectivePhaseSettings = (() => {
  const resolved = resolvePhaseSettings({ enabled: true });
  if (resolved.state !== 'on') {
    throw new Error('expected valid settings');
  }
  return resolved.settings;
})();

const baseCluster: ClusterSummary = {
  id: 'cluster-a',
  displayName: 'Cluster A',
  slurmClusterName: 'cluster_a',
  metricsDatasourceUid: 'prom-a',
  metricsType: 'prometheus',
  aggregationNodeLabels: ['host.name', 'instance'],
  instanceLabel: 'instance',
  nodeMatcherMode: 'host:port',
  defaultTemplateId: 'overview',
  metricsFilterLabel: '',
  metricsFilterValue: '',
};

interface Scenario {
  synthetic: SyntheticJob;
  job: JobRecord;
  cluster: ClusterSummary;
  client: FakeMetricsClient;
  nowSec: number;
}

function nodeNames(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `node-a${String(index + 1).padStart(3, '0')}`);
}

function scenario(spec: SyntheticJobSpec, overrides: { job?: Partial<JobRecord>; cluster?: Partial<ClusterSummary> } = {}): Scenario {
  const synthetic = generateSyntheticJob(spec);
  const nodes = nodeNames(spec.nodeCount);
  const job: JobRecord = {
    clusterId: 'cluster-a',
    jobId: 4242,
    name: 'train',
    user: 'user-a',
    account: 'account-a',
    partition: 'gpu',
    state: 'COMPLETED',
    nodes,
    nodeList: nodes.join(','),
    nodeCount: nodes.length,
    gpusTotal: spec.nodeCount * spec.gpusPerNode,
    submitTime: synthetic.startSec - 60,
    startTime: synthetic.startSec,
    endTime: synthetic.endSec,
    exitCode: 0,
    workDir: '/work',
    tres: '',
    templateId: 'overview',
    ...overrides.job,
  };
  const cluster = { ...baseCluster, ...overrides.cluster };
  const client = createFakeMetricsClient({
    job: synthetic,
    nodeNames: nodes,
    settings,
    cluster,
    instanceLabel: cluster.instanceLabel,
  });
  return { synthetic, job, cluster, client, nowSec: synthetic.endSec + 3600 };
}

function analyze(item: Scenario, client: MetricsClient = item.client, extra: { signal?: AbortSignal; nowSec?: number } = {}): Promise<JobPhasesOutcome> {
  return analyzeJobPhases({ job: item.job, cluster: item.cluster, settings, client, nowSec: extra.nowSec ?? item.nowSec, signal: extra.signal });
}

function ready(outcome: JobPhasesOutcome): JobPhasesAnalysis {
  if (outcome.state !== 'ready') {
    throw new Error(`expected a result, got ${outcome.state} (${outcome.reason})`);
  }
  return outcome.analysis;
}

function seconds(analysis: JobPhasesAnalysis, phase: PhaseId): number {
  return analysis.result.totals.find((total) => total.phase === phase)?.seconds ?? 0;
}

/** A client that passes range results through a function. */
function withRange(client: MetricsClient, transform: (series: PromRangeSeries[], expr: string) => PromRangeSeries[]): MetricsClient {
  return {
    instant: (expr, time) => client.instant(expr, time),
    range: async (expr, start, end, step) => transform(await client.range(expr, start, end, step), expr),
  };
}

function withInstant(client: MetricsClient, transform: (samples: PromInstantSample[], expr: string, index: number) => PromInstantSample[]): MetricsClient {
  let index = 0;
  return {
    instant: async (expr, time) => transform(await client.instant(expr, time), expr, index++),
    range: (expr, start, end, step) => client.range(expr, start, end, step),
  };
}

/** Sets the sample count that the counter probe reports for one metric, as if it were scraped at another interval. */
function withCounterSamples(client: MetricsClient, counts: Record<string, number>): MetricsClient {
  return withInstant(client, (samples) =>
    samples.map((sample) => {
      const count = counts[sample.metric.phase_metric];
      return count === undefined ? sample : { ...sample, metric: { ...sample.metric, samples: String(count) } };
    })
  );
}

describe('analyzeJobPhases: scrape intervals', () => {
  // The synthetic exporters are scraped every 15 s: 40 samples in the probe range of 600 s.
  const rangeOf = (item: Scenario, metric: string) => /\[(\d+)s\]/.exec(item.client.calls.find((call) => call.kind === 'range' && call.expr.includes(metric))!.expr)![1];
  const report = (analysis: JobPhasesAnalysis, signal: string) => analysis.signals.find((item) => item.signal === signal)!;

  it.each([
    ['the CPU counter every 30 s', { node_cpu_seconds_total: 20 }, 30, 120],
    ['the CPU counter every 60 s', { node_cpu_seconds_total: 10 }, 60, 240],
    ['every counter at the GPU interval', {}, 15, 60],
  ])('makes a bucket four scrape intervals of the slower of the GPU and CPU series: %s', async (_name, counts, scrapeSec, stepSec) => {
    const item = scenario(syntheticSpec(STAGES));
    const analysis = ready(await analyze(item, withCounterSamples(item.client, counts)));
    expect(analysis.window).toMatchObject({ scrapeSec, stepSec, scrapeMeasured: true });
    // The rate window of every query is the bucket.
    const ranges = item.client.calls.filter((call) => call.kind === 'range');
    expect(ranges.every((call) => call.step === stepSec && call.expr.includes(`[${stepSec}s]`))).toBe(true);
  });

  it('keeps one-minute buckets with a storage counter scraped every 300 s, and reads its rate over 20 minutes', async () => {
    const item = scenario(syntheticSpec(STAGES));
    const control = ready(await analyze(scenario(syntheticSpec(STAGES))));
    const analysis = ready(await analyze(item, withCounterSamples(item.client, { node_disk_written_bytes_total: 2 })));
    // The resolution of every label is that of the GPU and CPU series.
    expect(analysis.window).toMatchObject({ scrapeSec: 15, stepSec: 60, bucketCount: control.window.bucketCount });
    expect(item.client.calls.filter((call) => call.kind === 'range').every((call) => call.step === 60)).toBe(true);
    expect(rangeOf(item, 'node_disk_written_bytes_total')).toBe('1200');
    expect(rangeOf(item, 'node_cpu_seconds_total')).toBe('60');
    expect(rangeOf(item, 'DCGM_FI_DEV_POWER_USAGE')).toBe('60');
    expect(rangeOf(item, 'node_network_receive_bytes_total')).toBe('60');
    expect(report(analysis, 'storageWrite')).toMatchObject({ status: 'ok', scrapeSec: 300, rateWindowSec: 1200 });
    // The long window lies around its bucket: the storage query is evaluated nine buckets later than the others.
    const calls = item.client.calls.filter((call) => call.kind === 'range');
    const storage = calls.find((call) => call.expr.includes('node_disk_written_bytes_total'))!;
    const cpu = calls.find((call) => call.expr.includes('node_cpu_seconds_total'))!;
    expect([storage.start! - cpu.start!, storage.end! - cpu.end!]).toEqual([540, 540]);
    // The fake answers with the rate of each bucket, so the labels are those of the control run.
    expect(analysis.result.labels).toEqual(control.result.labels);
    expect(analysis.droppedPoints).toBe(0);
    expect(report(analysis, 'cpuBusy')).toMatchObject({ scrapeSec: 15, rateWindowSec: 60 });
    expect(report(analysis, 'network')).toMatchObject({ scrapeSec: 15, rateWindowSec: 60 });
    expect(report(analysis, 'gpuPower').rateWindowSec).toBeUndefined();
  });

  it('does not refuse a job of 16 minutes because its storage counter is scraped every 60 s', async () => {
    const item = scenario(syntheticSpec([stage('init', 2), stage('compute', 8), stage('checkpoint', 2), stage('compute', 4)]));
    const analysis = ready(await analyze(item, withCounterSamples(item.client, { node_disk_written_bytes_total: 10 })));
    expect(analysis.window).toMatchObject({ stepSec: 60, scrapeSec: 15 });
    expect(analysis.window.bucketCount).toBeGreaterThanOrEqual(14);
    expect(rangeOf(item, 'node_disk_written_bytes_total')).toBe('240');
  });

  it('reads a slow network counter over its own window too, without changing the buckets', async () => {
    const item = scenario(syntheticSpec(STAGES));
    const analysis = ready(await analyze(item, withCounterSamples(item.client, { node_network_receive_bytes_total: 5 })));
    expect(analysis.window).toMatchObject({ scrapeSec: 15, stepSec: 60 });
    expect(rangeOf(item, 'node_network_receive_bytes_total')).toBe('480');
    expect(rangeOf(item, 'node_disk_written_bytes_total')).toBe('60');
  });

  it('gives a slow counter a rate window of whole buckets that holds four of its scrape intervals', () => {
    expect(rateWindow(60, 15)).toBe(60);
    expect(rateWindow(60, 20)).toBe(120);
    expect(rateWindow(60, 60)).toBe(240);
    expect(rateWindow(60, 300)).toBe(1200);
    expect(rateWindow(120, 100)).toBe(480);
    expect(rateWindow(600, 15)).toBe(600);
    // An interval that could not be measured gives no reason for a longer window.
    expect(rateWindow(60, null)).toBe(60);
  });

  it('follows the slowest of several storage counters for the storage rate window', async () => {
    const twoCounters = resolvePhaseSettings({ enabled: true, storageWriteMetrics: ['node_disk_written_bytes_total', 'lustre_write_bytes_total'] });
    if (twoCounters.state !== 'on') {
      throw new Error('expected valid settings');
    }
    const item = scenario(syntheticSpec(STAGES));
    const fake = createFakeMetricsClient({ job: item.synthetic, nodeNames: [...new Set(item.job.nodes)], settings: twoCounters.settings, cluster: item.cluster });
    // The second counter is scraped every 120 s: 5 samples in the probe range.
    const client = withInstant(fake, (samples, expr) =>
      expr.includes('phase_metric') ? [...samples, { metric: { phase_metric: 'lustre_write_bytes_total', samples: '5' }, value: 2 }] : samples
    );
    const outcome = await analyzeJobPhases({ job: item.job, cluster: item.cluster, settings: twoCounters.settings, client, nowSec: item.nowSec });
    const analysis = ready(outcome);
    expect(analysis.window.stepSec).toBe(60);
    expect(analysis.signals.find((entry) => entry.signal === 'storageWrite')).toMatchObject({ scrapeSec: 120, rateWindowSec: 480 });
    const storage = fake.calls.find((call) => call.kind === 'range' && call.expr.includes('lustre_write_bytes_total'))!;
    expect(storage.expr).toContain('rate(node_disk_written_bytes_total{instance=~"(node-a001|node-a002):[0-9]+"}[480s])');
    expect(storage.expr).toContain('rate(lustre_write_bytes_total{instance=~"(node-a001|node-a002):[0-9]+"}[480s])');
  });

  it('says "too few samples" when the counters exist but no bucket has a rate, and "no series" when they do not exist', async () => {
    const emptyStorage = (client: MetricsClient) => withRange(client, (series, expr) => (expr.includes('node_disk_written_bytes_total') ? [] : series));
    const seen = scenario(syntheticSpec(STAGES));
    const tooFew = ready(await analyze(seen, emptyStorage(withCounterSamples(seen.client, { node_disk_written_bytes_total: 1 }))));
    expect(tooFew.signals.find((report) => report.signal === 'storageWrite')).toMatchObject({ status: 'too-few-samples', coverage: 0 });
    // One sample in the probe range gives no interval, so the buckets follow the other series.
    expect(tooFew.window.stepSec).toBe(60);
    expect(seconds(tooFew, 'checkpoint')).toBe(0);

    const absent = scenario(syntheticSpec(STAGES, { without: ['storageWrite'] }));
    const noSeries = ready(await analyze(absent));
    expect(noSeries.signals.find((report) => report.signal === 'storageWrite')).toMatchObject({ status: 'no-series', coverage: 0 });
  });
});

describe('analyzeJobPhases: GPUs that are not the job\'s', () => {
  it('finds them on a node whose GPU exporter is silent at the end of the run', async () => {
    // Two nodes with 8 GPUs each; the job holds 4 on each. Node 2 reports nothing in the last 15 minutes,
    // so the probe at the end of the run sees 8 GPUs, as many as the job allocated.
    const spec = syntheticSpec(STAGES, { gpusPerNode: 8, gaps: [{ node: 1, fromSec: 74 * MINUTE, toSec: 89 * MINUTE }] });
    const item = scenario(spec, { job: { gpusTotal: 8 } });
    await expect(analyze(item)).resolves.toEqual({ state: 'not-computed', reason: 'shared-nodes', gpusReported: 16, gpusAllocated: 8, queryCount: 3 });
  });

  it('does not take an exporter restart, which shows every GPU twice in one probe, for GPUs of other jobs', async () => {
    const item = scenario(syntheticSpec(STAGES));
    const restarted = withInstant(item.client, (samples, _expr, index) => (index === 0 ? samples.map((sample) => ({ ...sample, value: 2 * sample.value })) : samples));
    const analysis = ready(await analyze(item, restarted));
    expect(analysis.gpuCounts).toEqual({ perNode: [4, 4], total: 8 });
  });

  it('takes the lower count of a node that only two probes see', async () => {
    const item = scenario(syntheticSpec(STAGES));
    const twoProbes = withInstant(item.client, (samples, _expr, index) => {
      if (index === 1) {
        return [];
      }
      return index === 0 ? samples.map((sample) => ({ ...sample, value: 2 * sample.value })) : samples;
    });
    expect(ready(await analyze(item, twoProbes)).gpuCounts).toEqual({ perNode: [4, 4], total: 8 });
  });

  it('probes a short job once, at its end', async () => {
    const item = scenario(syntheticSpec([stage('compute', 15)]));
    ready(await analyze(item));
    expect(item.client.calls.filter((call) => call.kind === 'instant').map((call) => call.time)).toEqual([item.synthetic.endSec, item.synthetic.endSec]);
  });
});

describe('analyzeJobPhases', () => {
  it('sends four probes and six range queries in order and segments the job', async () => {
    const item = scenario(syntheticSpec(STAGES));
    const analysis = ready(await analyze(item));

    const kinds = item.client.calls.map((call) => call.kind);
    expect(kinds).toEqual(['instant', 'instant', 'instant', 'instant', 'range', 'range', 'range', 'range', 'range', 'range']);
    expect(analysis.queryCount).toBe(10);
    // The GPU probe looks at the end of the run, ten minutes after its start and its middle; the counter probe at the end.
    const { startSec, endSec } = item.synthetic;
    expect(item.client.calls.slice(0, 4).map((call) => call.time)).toEqual([endSec, startSec + 600, Math.floor((startSec + 600 + endSec) / 2), endSec]);
    expect(item.client.calls.slice(0, 3).every((call) => call.expr.startsWith('count_values by (instance) ("samples", count_over_time(DCGM_FI_DEV_GPU_UTIL{'))).toBe(true);
    expect(item.client.calls[3].expr).toContain('count_values by (phase_metric) ("samples", label_replace(count_over_time(node_cpu_seconds_total{');
    expect(analysis.window).toMatchObject({ stepSec: 60, scrapeSec: 15, scrapeMeasured: true, running: false });
    const range = item.client.calls[4];
    expect(range.start).toBe(analysis.window.startSec + 60);
    expect(range.end).toBe(analysis.window.endSec);
    expect(range.step).toBe(60);

    expect(analysis.nodes).toEqual(['node-a001', 'node-a002']);
    expect(analysis.result.segments.map((segment) => segment.phase)).toEqual(['init', 'compute', 'checkpoint', 'compute', 'stalled']);
    expect(seconds(analysis, 'init')).toBeGreaterThanOrEqual(5 * MINUTE);
    expect(seconds(analysis, 'checkpoint')).toBe(3 * MINUTE);
    expect(seconds(analysis, 'stalled')).toBeGreaterThanOrEqual(19 * MINUTE);
    expect(analysis.signals.map((report) => [report.signal, report.status])).toEqual([
      ['gpuUtilMax', 'ok'],
      ['gpuUtilMean', 'ok'],
      ['gpuPower', 'ok'],
      ['cpuBusy', 'ok'],
      ['storageWrite', 'ok'],
      ['network', 'ok'],
    ]);
    expect(analysis.signals.every((report) => report.coverage === 1)).toBe(true);
    expect(analysis.gpuCounts).toEqual({ perNode: [4, 4], total: 8 });
    expect(analysis.gpusAllocated).toBe(8);
    expect(analysis.droppedPoints).toBe(0);
  });

  it('uses longer buckets for a longer scrape interval', async () => {
    const analysis = ready(await analyze(scenario(syntheticSpec(STAGES, { scrapeSec: 30 }))));
    expect(analysis.window).toMatchObject({ stepSec: 120, scrapeSec: 30 });
    expect(analysis.result.totals.map((total) => total.phase)).toEqual(['init', 'compute', 'checkpoint', 'stalled']);
  });

  it('says what it is based on when the cluster has no disk series, and reports no checkpoint', async () => {
    const analysis = ready(await analyze(scenario(syntheticSpec(STAGES, { without: ['storageWrite'] }))));
    const write = analysis.signals.find((report) => report.signal === 'storageWrite');
    // The probe found no series, so there is no scrape interval and the rate window is the bucket.
    expect(write).toEqual({ signal: 'storageWrite', metrics: ['node_disk_written_bytes_total'], status: 'no-series', coverage: 0, scrapeSec: null, rateWindowSec: 60 });
    expect(seconds(analysis, 'checkpoint')).toBe(0);
    expect(analysis.result.unclassifiedReasons.map((total) => total.reason)).toEqual(['gpu-low-write-unknown']);
    expect(seconds(analysis, 'stalled')).toBeGreaterThanOrEqual(19 * MINUTE);
  });

  it('works without network and CPU series, and reports no stall without the CPU series', async () => {
    const analysis = ready(await analyze(scenario(syntheticSpec(STAGES, { without: ['network', 'cpu'] }))));
    expect(analysis.signals.filter((report) => report.status === 'no-series').map((report) => report.signal)).toEqual(['cpuBusy', 'network']);
    expect(analysis.result.segments.map((segment) => [segment.phase, segment.reason])).toEqual([
      ['init', undefined],
      ['compute', undefined],
      ['checkpoint', undefined],
      ['compute', undefined],
      ['unclassified', 'gpu-idle-cpu-unknown'],
    ]);
    // Without a CPU probe the GPU exporter's scrape interval decides the bucket length.
    expect(analysis.window.scrapeMeasured).toBe(true);
  });

  it('analyses a running job up to a moment whose samples are stored', async () => {
    const item = scenario(syntheticSpec(STAGES), { job: { endTime: 0, state: 'RUNNING' } });
    const nowSec = item.synthetic.endSec;
    const analysis = ready(await analyze(item, item.client, { nowSec }));
    expect(analysis.window.running).toBe(true);
    expect(analysis.window.endSec).toBeLessThanOrEqual(nowSec - 90);
    expect(analysis.result.segments[analysis.result.segments.length - 1].phase).toBe('stalled');
  });
});

describe('analyzeJobPhases: jobs without a result', () => {
  it('sends no query for a job that is shorter than five buckets', async () => {
    // Nine samples at a 15 s scrape interval.
    const item = scenario(syntheticSpec([{ phase: 'compute', seconds: 135 }]));
    await expect(analyze(item)).resolves.toEqual({ state: 'not-computed', reason: 'too-short', stepSec: 60, queryCount: 0 });
    expect(item.client.calls).toEqual([]);
  });

  it('sends two probes for a job that is too short for the buckets its scrape interval needs', async () => {
    const item = scenario(syntheticSpec([stage('compute', 12)], { scrapeSec: 60 }));
    await expect(analyze(item)).resolves.toEqual({ state: 'not-computed', reason: 'too-short', stepSec: 240, queryCount: 2 });
    expect(item.client.calls).toHaveLength(2);
  });

  it('sends no query for a job that has not started', async () => {
    const item = scenario(syntheticSpec(STAGES), { job: { startTime: 0, endTime: 0, state: 'PENDING' } });
    await expect(analyze(item)).resolves.toEqual({ state: 'not-computed', reason: 'not-started', queryCount: 0 });
    expect(item.client.calls).toEqual([]);
  });

  it('sends no query for a job with more nodes than the point budget allows', async () => {
    const item = scenario(syntheticSpec(STAGES), { job: { nodes: nodeNames(MAX_NODES + 1) } });
    await expect(analyze(item)).resolves.toEqual({
      state: 'not-computed',
      reason: 'too-many-nodes',
      maxNodes: MAX_NODES,
      nodeCount: MAX_NODES + 1,
      queryCount: 0,
    });
    expect(item.client.calls).toEqual([]);
  });

  it('sends one query for a job without allocated GPUs whose nodes report no GPU', async () => {
    const item = scenario(syntheticSpec(STAGES, { without: ['gpuUtil', 'gpuPower'] }), { job: { gpusTotal: 0 } });
    await expect(analyze(item)).resolves.toEqual({ state: 'not-computed', reason: 'no-gpus', queryCount: 1 });
    expect(item.client.calls).toHaveLength(1);
  });

  it('sends the probes and the three GPU queries, and no more, when allocated GPUs report nothing', async () => {
    const item = scenario(syntheticSpec(STAGES, { without: ['gpuUtil', 'gpuPower'] }));
    await expect(analyze(item)).resolves.toEqual({ state: 'not-computed', reason: 'no-gpu-telemetry', queryCount: 7 });
    expect(item.client.calls.map((call) => call.kind)).toEqual(['instant', 'instant', 'instant', 'instant', 'range', 'range', 'range']);
  });

  it('sends only the GPU probes and gives no result when the nodes report more GPUs than the job allocated', async () => {
    // The job holds 4 of the 16 GPUs of its nodes; the node averages would mix in the other 12.
    const item = scenario(syntheticSpec(STAGES, { gpusPerNode: 8 }), { job: { gpusTotal: 4 } });
    await expect(analyze(item)).resolves.toEqual({ state: 'not-computed', reason: 'shared-nodes', gpusReported: 16, gpusAllocated: 4, queryCount: 3 });
    expect(item.client.calls.map((call) => call.kind)).toEqual(['instant', 'instant', 'instant']);
  });

  it('ignores series of nodes outside the job, so foreign telemetry gives no result', async () => {
    const item = scenario(syntheticSpec(STAGES));
    const foreign = withRange(item.client, (series) => series.map((entry) => ({ ...entry, metric: { instance: 'node-z999:9400' } })));
    await expect(analyze(item, foreign)).resolves.toMatchObject({ state: 'not-computed', reason: 'no-gpu-telemetry' });
  });
});

describe('analyzeJobPhases: failures', () => {
  it.each([
    [0, 'the GPU count and scrape interval'],
    [2, 'the GPU count and scrape interval'],
    [3, 'the scrape intervals of the CPU, storage and network counters'],
  ])('rejects when probe %i fails, and names what it reads', async (failAt, subject) => {
    const item = scenario(syntheticSpec(STAGES));
    let sent = 0;
    const failing: MetricsClient = {
      ...item.client,
      instant: (expr, time) => (sent++ === failAt ? Promise.reject(new MetricsQueryError('HTTP 502')) : item.client.instant(expr, time)),
    };
    const error = await analyze(item, failing).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PhaseQueryFailed);
    expect((error as Error).message).toBe(`The query for ${subject} failed: Metrics query failed (HTTP 502)`);
  });

  // A failed query says nothing about the job. Continuing without the signal would read the
  // failure as "no series": a failed CPU query would turn CPU-only work into a stall.
  it.each([
    ['DCGM_FI_DEV_GPU_UTIL', 'GPU utilization (highest sample)'],
    ['DCGM_FI_DEV_POWER_USAGE', 'GPU power'],
    ['node_cpu_seconds_total', 'CPU load'],
    ['node_disk_written_bytes_total', 'Storage write rate'],
    ['node_network_receive_bytes_total', 'Network rate'],
  ])('gives no result when the range query of %s fails, and names the signal and the cause', async (metric, subject) => {
    const item = scenario(syntheticSpec(STAGES));
    const failing = withRange(item.client, (series, expr) => {
      if (expr.includes(metric)) {
        throw new MetricsQueryError('query timed out');
      }
      return series;
    });
    const error = await analyze(item, failing).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PhaseQueryFailed);
    expect((error as Error).message).toBe(`The query for ${subject} failed: Metrics query failed (query timed out)`);
  });

  it('never reports a stall from a CPU query that failed', async () => {
    // GPUs idle with busy CPUs after compute: unclassified with the CPU series, and an error without it.
    const stages = [
      { phase: 'compute' as const, seconds: 3600 },
      { phase: 'cpu-work' as const, seconds: 3600 },
    ];
    const item = scenario(syntheticSpec(stages));
    const complete = ready(await analyze(item));
    expect(seconds(complete, 'stalled')).toBe(0);
    const failing = withRange(scenario(syntheticSpec(stages)).client, (series, expr) => {
      if (expr.includes('node_cpu_seconds_total')) {
        throw new MetricsQueryError('HTTP 502');
      }
      return series;
    });
    await expect(analyze(item, failing)).rejects.toThrow('The query for CPU load failed: Metrics query failed (HTTP 502)');
  });

  it('stops sending queries when the signal aborts', async () => {
    const item = scenario(syntheticSpec(STAGES));
    const controller = new AbortController();
    const aborting = withRange(item.client, (series) => {
      controller.abort();
      return series;
    });
    await expect(analyze(item, aborting, { signal: controller.signal })).rejects.toBeInstanceOf(PhaseAnalysisAborted);
    expect(item.client.calls.map((call) => call.kind)).toEqual(['instant', 'instant', 'instant', 'instant', 'range']);
  });

  it('sends nothing when the signal is aborted before the start', async () => {
    const item = scenario(syntheticSpec(STAGES));
    const controller = new AbortController();
    controller.abort();
    await expect(analyze(item, item.client, { signal: controller.signal })).rejects.toBeInstanceOf(PhaseAnalysisAborted);
    expect(item.client.calls).toEqual([]);
  });
});

describe('analyzeJobPhases: reading responses', () => {
  it('drops and counts points that are not on the bucket grid instead of guessing their bucket', async () => {
    const item = scenario(syntheticSpec(STAGES));
    const shifted = withRange(item.client, (series, expr) =>
      expr.includes('node_disk_written_bytes_total')
        ? series.map((entry) => ({ ...entry, values: entry.values.map(([time, value]): [number, number] => [time + 7, value]) }))
        : series
    );
    const analysis = ready(await analyze(item, shifted));
    expect(analysis.droppedPoints).toBeGreaterThan(0);
    // Not "no series" and not "too few samples": the backend answered, with points that cannot be used.
    expect(analysis.signals.find((report) => report.signal === 'storageWrite')?.status).toBe('invalid');
    expect(seconds(analysis, 'checkpoint')).toBe(0);
  });

  it('drops points outside the window', async () => {
    const item = scenario(syntheticSpec(STAGES));
    const extra = withRange(item.client, (series) =>
      series.map((entry) => ({ ...entry, values: [[entry.values[0][0] - 60, 999] as [number, number], ...entry.values] }))
    );
    const analysis = ready(await analyze(item, extra));
    expect(analysis.droppedPoints).toBe(12);
    expect(analysis.result.segments.map((segment) => segment.phase)).toEqual(['init', 'compute', 'checkpoint', 'compute', 'stalled']);
  });

  describe('CPU values outside 0 to 100%', () => {
    // STAGES: 89 buckets of one minute on two nodes, with a stall in the last 20 minutes.
    /** Replaces the CPU value of node 1 in the given buckets (counted from the start of the window). */
    const withCpuValues = (client: MetricsClient, values: Record<number, number>) =>
      withRange(client, (series, expr) =>
        expr.includes('node_cpu_seconds_total')
          ? series.map((entry, node) =>
              node === 0 ? { ...entry, values: entry.values.map(([time, value], bucket): [number, number] => [time, values[bucket] ?? value]) } : entry
            )
          : series
      );
    const cpuReport = (analysis: JobPhasesAnalysis) => analysis.signals.find((report) => report.signal === 'cpuBusy')!;

    it('leaves out one value of a late node exporter, keeps the signal, and still reports the stall', async () => {
      const control = ready(await analyze(scenario(syntheticSpec(STAGES))));
      const item = scenario(syntheticSpec(STAGES));
      // One minute in the stall in which the exporter of one node answered late: -9.5 % CPU load.
      const analysis = ready(await analyze(item, withCpuValues(item.client, { 80: -0.095 })));
      expect(cpuReport(analysis)).toMatchObject({ status: 'ok', values: cpuReport(control).values, unusableValues: 1 });
      expect(cpuReport(control).unusableValues).toBe(0);
      expect(analysis.result.labels).toEqual(control.result.labels);
      expect(seconds(analysis, 'stalled')).toBe(seconds(control, 'stalled'));
      expect(seconds(analysis, 'stalled')).toBeGreaterThanOrEqual(19 * MINUTE);
      // The cell is missing, not zero and not clamped.
      expect(analysis.result.coverage.cpuBusy).toBeCloseTo(1 - 1 / (2 * analysis.window.bucketCount), 12);
    });

    it('clamps a value within 5 points of the range and leaves out a value further outside', async () => {
      const item = scenario(syntheticSpec(STAGES));
      const inside = ready(await analyze(item, withCpuValues(item.client, { 78: -0.05, 79: 1.05, 80: -0.04 })));
      expect(cpuReport(inside)).toMatchObject({ status: 'ok', unusableValues: 0 });
      expect(inside.result.coverage.cpuBusy).toBe(1);
      const other = scenario(syntheticSpec(STAGES));
      const outside = ready(await analyze(other, withCpuValues(other.client, { 78: -0.051, 79: 1.051, 80: -0.3 })));
      expect(cpuReport(outside)).toMatchObject({ status: 'ok', unusableValues: 3 });
    });

    it('uses the signal with a tenth of its values left out, and not with more', async () => {
      const item = scenario(syntheticSpec(STAGES));
      const total = cpuReport(ready(await analyze(item))).values!;
      const outOfRange = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [index, -0.5]));
      const tenth = Math.floor(total / 10);

      const kept = scenario(syntheticSpec(STAGES));
      const usable = ready(await analyze(kept, withCpuValues(kept.client, outOfRange(tenth))));
      expect(cpuReport(usable)).toMatchObject({ status: 'ok', values: total, unusableValues: tenth });
      expect(usable.result.coverage.cpuBusy).toBeGreaterThan(0);

      const dropped = scenario(syntheticSpec(STAGES));
      const unusable = ready(await analyze(dropped, withCpuValues(dropped.client, outOfRange(tenth + 1))));
      expect(cpuReport(unusable)).toMatchObject({ status: 'invalid', values: total, unusableValues: tenth + 1 });
      expect(unusable.result.coverage.cpuBusy).toBe(0);
      // Without a usable CPU signal no stall is reported; the reason is "too little CPU telemetry".
      expect(seconds(unusable, 'stalled')).toBe(0);
    });
  });

  it('refuses CPU values that cannot be a share of CPU time', async () => {
    const item = scenario(syntheticSpec(STAGES));
    const broken = withRange(item.client, (series, expr) =>
      expr.includes('node_cpu_seconds_total') ? series.map((entry) => ({ ...entry, values: entry.values.map(([time]): [number, number] => [time, -90]) })) : series
    );
    const analysis = ready(await analyze(item, broken));
    expect(analysis.signals.find((report) => report.signal === 'cpuBusy')?.status).toBe('invalid');
    expect(analysis.result.coverage.cpuBusy).toBe(0);
  });

  it('clamps CPU values that are outside 0..1 by a rounding effect', async () => {
    const item = scenario(syntheticSpec(STAGES));
    const nearly = withRange(item.client, (series, expr) =>
      expr.includes('node_cpu_seconds_total') ? series.map((entry) => ({ ...entry, values: entry.values.map(([time]): [number, number] => [time, -0.01]) })) : series
    );
    const analysis = ready(await analyze(item, nearly));
    expect(analysis.signals.find((report) => report.signal === 'cpuBusy')?.status).toBe('ok');
    expect(analysis.result.totals.find((total) => total.phase === 'compute')?.evidence.cpuBusy).toBe(0);
  });

  it('combines two exporters of one node: the higher maximum, the mean of the means, the sum of the rates', async () => {
    const item = scenario(syntheticSpec(STAGES, { nodeCount: 1 }));
    const doubled = withRange(item.client, (series) => [
      ...series,
      ...series.map((entry) => ({ metric: { instance: 'node-a001:9999' }, values: entry.values.map(([time, value]): [number, number] => [time, value * 3]) })),
    ]);
    const single = ready(await analyze(item));
    const analysis = ready(await analyze(scenario(syntheticSpec(STAGES, { nodeCount: 1 })), doubled));
    const compute = (source: JobPhasesAnalysis) => source.result.totals.find((total) => total.phase === 'compute')!.evidence;
    expect(compute(analysis).gpuPowerWatts).toBeCloseTo(2 * compute(single).gpuPowerWatts!, 6);
    expect(compute(analysis).storageWriteBytesPerSecond).toBeCloseTo(4 * compute(single).storageWriteBytesPerSecond!, 3);
  });

  it('takes the higher of two utilization maxima of one node, so a second exporter that reads zero does not make the node idle', async () => {
    const item = scenario(syntheticSpec(STAGES, { nodeCount: 1 }));
    const withZeroExporter = withRange(item.client, (series, expr) =>
      expr.startsWith('max by')
        ? [...series, ...series.map((entry) => ({ metric: { instance: 'node-a001:9999' }, values: entry.values.map(([time]): [number, number] => [time, 0]) }))]
        : series
    );
    const single = ready(await analyze(item));
    const analysis = ready(await analyze(scenario(syntheticSpec(STAGES, { nodeCount: 1 })), withZeroExporter));
    expect(analysis.result.labels).toEqual(single.result.labels);
    expect(seconds(analysis, 'compute')).toBeGreaterThan(50 * MINUTE);
  });

  it('matches host names without a port and a custom instance label', async () => {
    const item = scenario(syntheticSpec(STAGES), { cluster: { nodeMatcherMode: 'hostname', instanceLabel: 'host.name' } });
    const bare = withRange(item.client, (series) => series.map((entry) => ({ ...entry, metric: { 'host.name': entry.metric['host.name'].replace(/:\d+$/, '') } })));
    const analysis = ready(await analyze(item, bare));
    expect(analysis.result.segments.map((segment) => segment.phase)).toEqual(['init', 'compute', 'checkpoint', 'compute', 'stalled']);
    // With hostname matching an instance with a port is another host.
    await expect(analyze(scenario(syntheticSpec(STAGES), { cluster: { nodeMatcherMode: 'hostname' } }))).resolves.toMatchObject({
      state: 'not-computed',
      reason: 'no-gpu-telemetry',
    });
  });

  it('counts a node that is listed twice once', async () => {
    const item = scenario(syntheticSpec(STAGES, { nodeCount: 1 }), { job: { nodes: ['node-a001', 'node-a001'] } });
    const analysis = ready(await analyze(item));
    expect(analysis.nodes).toEqual(['node-a001']);
    expect(analysis.result.nodeCount).toBe(1);
  });

  it('reports the GPUs that the nodes report next to the GPUs the job allocated', async () => {
    const analysis = ready(await analyze(scenario(syntheticSpec(STAGES, { gpusPerNode: 2 }), { job: { gpusTotal: 8 } })));
    expect(analysis.gpuCounts).toEqual({ perNode: [2, 2], total: 4 });
    expect(analysis.gpusAllocated).toBe(8);
  });

  it('segments a job whose allocation records no GPU count when its nodes report GPUs', async () => {
    const analysis = ready(await analyze(scenario(syntheticSpec(STAGES), { job: { gpusTotal: 0 } })));
    expect(analysis.gpuCounts?.total).toBe(8);
    expect(analysis.result.segments.map((segment) => segment.phase)).toEqual(['init', 'compute', 'checkpoint', 'compute', 'stalled']);
  });
});

describe('analyzeJobPhases: cost', () => {
  it('keeps every response of a 64-node job of two days within the point budget', async () => {
    const stages = [stage('init', 30), stage('compute', 24 * 60), stage('checkpoint', 60), stage('compute', 22 * 60), stage('stalled', 90)];
    const item = scenario(syntheticSpec(stages, { nodeCount: 64, gpusPerNode: 1, scrapeSec: 60 }));
    const points: number[] = [];
    const counting = withRange(item.client, (series) => {
      points.push(series.reduce((sum, entry) => sum + entry.values.length, 0));
      return series;
    });
    const analysis = ready(await analyze(item, counting));
    expect(points).toHaveLength(6);
    expect(Math.max(...points)).toBeLessThanOrEqual(POINT_BUDGET);
    expect(analysis.window.bucketCount * 64).toBeLessThanOrEqual(POINT_BUDGET);
    expect(analysis.window.stepSec).toBe(600);
    expect(analysis.queryCount).toBe(10);
    expect(analysis.result.totals.map((total) => total.phase)).toEqual(['init', 'compute', 'checkpoint', 'stalled']);
  }, 30_000);
});
