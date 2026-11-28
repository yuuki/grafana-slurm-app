import type { ClusterSummary, JobRecord } from '../../../api/types';
import { analyzeJobPhases, JobPhasesAnalysis, JobPhasesOutcome, PhaseAnalysisAborted } from './collect';
import { MAX_NODES, POINT_BUDGET } from './plan';
import { MetricsClient, MetricsQueryError, PromRangeSeries } from './promClient';
import { buildQueryContext } from './queries';
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
    context: buildQueryContext([...new Set(job.nodes)], cluster),
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

describe('analyzeJobPhases', () => {
  it('sends two probes and six range queries in order and segments the job', async () => {
    const item = scenario(syntheticSpec(STAGES));
    const analysis = ready(await analyze(item));

    expect(item.client.calls.map((call) => call.kind)).toEqual(['instant', 'instant', 'range', 'range', 'range', 'range', 'range', 'range']);
    expect(analysis.queryCount).toBe(8);
    expect(analysis.window).toMatchObject({ stepSec: 60, scrapeSec: 15, scrapeMeasured: true, running: false });
    const range = item.client.calls[2];
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
    expect(write).toEqual({ signal: 'storageWrite', metrics: ['node_disk_written_bytes_total'], status: 'no-series', coverage: 0 });
    expect(seconds(analysis, 'checkpoint')).toBe(0);
    expect(analysis.result.unclassifiedReasons.map((total) => total.reason)).toEqual(['gpu-low-write-unknown']);
    expect(seconds(analysis, 'stalled')).toBeGreaterThanOrEqual(19 * MINUTE);
  });

  it('works without network and CPU series', async () => {
    const analysis = ready(await analyze(scenario(syntheticSpec(STAGES, { without: ['network', 'cpu'] }))));
    expect(analysis.signals.filter((report) => report.status === 'no-series').map((report) => report.signal)).toEqual(['cpuBusy', 'network']);
    expect(analysis.result.segments.map((segment) => segment.phase)).toEqual(['init', 'compute', 'checkpoint', 'compute', 'stalled']);
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
    await expect(analyze(item)).resolves.toEqual({ state: 'not-computed', reason: 'too-many-nodes', maxNodes: MAX_NODES, queryCount: 0 });
    expect(item.client.calls).toEqual([]);
  });

  it('sends one query for a job without allocated GPUs whose nodes report no GPU', async () => {
    const item = scenario(syntheticSpec(STAGES, { without: ['gpuUtil', 'gpuPower'] }), { job: { gpusTotal: 0 } });
    await expect(analyze(item)).resolves.toEqual({ state: 'not-computed', reason: 'no-gpus', queryCount: 1 });
    expect(item.client.calls).toHaveLength(1);
  });

  it('sends the probes and the three GPU queries, and no more, when allocated GPUs report nothing', async () => {
    const item = scenario(syntheticSpec(STAGES, { without: ['gpuUtil', 'gpuPower'] }));
    await expect(analyze(item)).resolves.toEqual({ state: 'not-computed', reason: 'no-gpu-telemetry', queryCount: 5 });
    expect(item.client.calls.map((call) => call.kind)).toEqual(['instant', 'instant', 'range', 'range', 'range']);
  });

  it('sends one query and gives no result when the nodes report more GPUs than the job allocated', async () => {
    // The job holds 4 of the 16 GPUs of its nodes; the node averages would mix in the other 12.
    const item = scenario(syntheticSpec(STAGES, { gpusPerNode: 8 }), { job: { gpusTotal: 4 } });
    await expect(analyze(item)).resolves.toEqual({ state: 'not-computed', reason: 'shared-nodes', gpusReported: 16, gpusAllocated: 4, queryCount: 1 });
    expect(item.client.calls).toHaveLength(1);
  });

  it('ignores series of nodes outside the job, so foreign telemetry gives no result', async () => {
    const item = scenario(syntheticSpec(STAGES));
    const foreign = withRange(item.client, (series) => series.map((entry) => ({ ...entry, metric: { instance: 'node-z999:9400' } })));
    await expect(analyze(item, foreign)).resolves.toMatchObject({ state: 'not-computed', reason: 'no-gpu-telemetry' });
  });
});

describe('analyzeJobPhases: failures', () => {
  it('rejects when a probe fails', async () => {
    const item = scenario(syntheticSpec(STAGES));
    const failing: MetricsClient = { ...item.client, instant: () => Promise.reject(new MetricsQueryError('HTTP 502')) };
    await expect(analyze(item, failing)).rejects.toThrow('Metrics query failed (HTTP 502)');
  });

  it('rejects when a GPU query fails, instead of segmenting on half of the GPU signals', async () => {
    const item = scenario(syntheticSpec(STAGES));
    const failing = withRange(item.client, (series, expr) => {
      if (expr.includes('DCGM_FI_DEV_POWER_USAGE')) {
        throw new MetricsQueryError('query timed out');
      }
      return series;
    });
    await expect(analyze(item, failing)).rejects.toThrow('Metrics query failed (query timed out)');
  });

  it('continues without a signal whose query fails, and names the failure', async () => {
    const item = scenario(syntheticSpec(STAGES));
    const failing = withRange(item.client, (series, expr) => {
      if (expr.includes('node_disk_written_bytes_total')) {
        throw new MetricsQueryError('query timed out');
      }
      return series;
    });
    const analysis = ready(await analyze(item, failing));
    expect(analysis.signals.find((report) => report.signal === 'storageWrite')).toEqual({
      signal: 'storageWrite',
      metrics: ['node_disk_written_bytes_total'],
      status: 'failed',
      coverage: 0,
      error: 'Metrics query failed (query timed out)',
    });
    expect(seconds(analysis, 'checkpoint')).toBe(0);
    expect(analysis.queryCount).toBe(8);
  });

  it('stops sending queries when the signal aborts', async () => {
    const item = scenario(syntheticSpec(STAGES));
    const controller = new AbortController();
    const aborting = withRange(item.client, (series) => {
      controller.abort();
      return series;
    });
    await expect(analyze(item, aborting, { signal: controller.signal })).rejects.toBeInstanceOf(PhaseAnalysisAborted);
    expect(item.client.calls.map((call) => call.kind)).toEqual(['instant', 'instant', 'range']);
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
    expect(analysis.signals.find((report) => report.signal === 'storageWrite')?.status).toBe('no-series');
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
    expect(analysis.queryCount).toBe(8);
    expect(analysis.result.totals.map((total) => total.phase)).toEqual(['init', 'compute', 'checkpoint', 'stalled']);
  }, 30_000);
});
