import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ClusterSummary, JobRecord } from '../../../api/types';
import { FakeMetrics } from '../efficiency/__fixtures__/fakeMetrics';
import { computeJobEfficiency, JobEfficiency } from '../efficiency/scorecard';
import { EFFICIENCY_DEFAULTS } from '../efficiency/settings';
import { EfficiencyState } from '../efficiency/useJobEfficiency';
import { activityBadge, EfficiencyScorecard, JobEfficiencySection, SEVERITY_BADGE } from './EfficiencyScorecard';

// Grafana's Icon loads its SVG asynchronously, which would update state after
// a test has finished. The badges are found by their text.
jest.mock('react-inlinesvg', () => ({ __esModule: true, default: () => null }));

const mockCreateDatasourceClient = jest.fn();

jest.mock('../efficiency/promClient', () => ({
  createDatasourceClient: (...args: unknown[]) => mockCreateDatasourceClient(...args),
}));

const START = 1_700_000_040;
const HOUR = 3600;

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

/** A node of eight 80 GiB GPUs: the first `activeGpus` run at 85%, the rest stay idle. */
function halfIdleMetrics(activeGpus: number, gpuCount = 8): FakeMetrics {
  return new FakeMetrics({
    gpus: Array.from({ length: gpuCount }, (_, index) => ({
      instance: 'gpu-node001:9400',
      gpu: String(index),
      utilization: () => (index < activeGpus ? 85 : 0),
      usedMiB: () => (index < activeGpus ? 9000 : 3),
      freeMiB: () => (index < activeGpus ? 72920 : 81917),
    })),
    nodes: [{ instance: 'gpu-node001:9100', cpus: 16, busyShare: () => 0.4, ioWaitShare: () => 0.01 }],
  });
}

async function scoreWith(metrics: FakeMetrics, job = makeJob(), now = START + 100 * HOUR): Promise<JobEfficiency> {
  return computeJobEfficiency({ job, cluster, nowSeconds: now, client: metrics });
}

function renderState(state: EfficiencyState, onRetry = jest.fn()) {
  render(<EfficiencyScorecard state={state} onRetry={onRetry} />);
  return onRetry;
}

describe('EfficiencyScorecard', () => {
  it('shows a loading state while the job is scored', () => {
    renderState({ status: 'loading' });

    expect(screen.getByRole('region', { name: 'Job efficiency' })).toBeInTheDocument();
    expect(screen.getByText('Scoring job efficiency...')).toBeInTheDocument();
  });

  it('shows tiles, findings with evidence and advice, and the scored window', async () => {
    renderState({ status: 'done', result: await scoreWith(halfIdleMetrics(4)) });

    expect(within(screen.getByTestId('efficiency-tile-time-in-use')).getByText('50%')).toBeInTheDocument();
    expect(within(screen.getByTestId('efficiency-tile-idle-gpu-hours')).getByText('4.00')).toBeInTheDocument();
    expect(within(screen.getByTestId('efficiency-tile-never-active-gpus')).getByText('4 of 8')).toBeInTheDocument();
    expect(within(screen.getByTestId('efficiency-tile-peak-gpu-memory')).getByText('11%')).toBeInTheDocument();

    const idleGpus = within(screen.getByTestId('efficiency-finding-idle-gpus'));
    expect(idleGpus.getByText('Warning')).toBeInTheDocument();
    expect(
      idleGpus.getByText(
        '4 of the 8 allocated GPUs never exceeded 5% utilization in the scored window (gpu-node001: GPU 4, 5, 6, 7). At most 4 of them were active at the same time.'
      )
    ).toBeInTheDocument();
    expect(idleGpus.getByText('The workload ran on at most 4 GPUs. Request 4 instead of 8.')).toBeInTheDocument();

    // A finding without waste carries its evidence but no advice.
    const bottleneck = within(screen.getByTestId('efficiency-finding-input-pipeline'));
    expect(bottleneck.getByText('OK')).toBeInTheDocument();
    expect(bottleneck.queryByText('Advice:')).not.toBeInTheDocument();

    expect(screen.getByText('Scored window: 1h 0m in 60 buckets of 1m.')).toBeInTheDocument();
    // A finished job is not scored again.
    expect(screen.queryByRole('button', { name: 'Score again' })).not.toBeInTheDocument();
  });

  it('lists the per-GPU evidence on demand, idle GPUs first', async () => {
    renderState({ status: 'done', result: await scoreWith(halfIdleMetrics(4)) });

    const toggle = screen.getByRole('button', { name: 'Per-GPU evidence (8)' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(rows).toHaveLength(9);
    expect(within(rows[1]).getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
      'gpu-node001',
      '4',
      'Idle',
      '0%',
      '0%',
      '0%',
      '0.0 GiB of 80.0 GiB (0.004%)'.replace('0.004%', '0%'),
    ]);
    expect(within(rows[5]).getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
      'gpu-node001',
      '0',
      'Active',
      '85%',
      '85%',
      '100%',
      '8.8 GiB of 80.0 GiB (11%)',
    ]);
  });

  it('shows a limited number of GPU rows until asked for all', async () => {
    const result = await scoreWith(halfIdleMetrics(40, 40), makeJob({ gpusTotal: 40 }));
    renderState({ status: 'done', result });

    fireEvent.click(screen.getByRole('button', { name: 'Per-GPU evidence (40)' }));
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(33);

    fireEvent.click(screen.getByRole('button', { name: 'Show all 40 GPUs' }));
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(41);
    expect(screen.queryByRole('button', { name: 'Show all 40 GPUs' })).not.toBeInTheDocument();
  });

  it('marks bounds and inconclusive findings on nodes shared with other jobs', async () => {
    const result = await scoreWith(halfIdleMetrics(1), makeJob({ gpusTotal: 6, cpusTotal: 12 }));
    renderState({ status: 'done', result });

    expect(within(screen.getByTestId('efficiency-tile-never-active-gpus')).getByText('≥ 5 of 6')).toBeInTheDocument();
    expect(within(screen.getByTestId('efficiency-tile-idle-gpu-hours')).getByText('≥ 5.00')).toBeInTheDocument();
    expect(within(screen.getByTestId('efficiency-finding-idle-gpus')).getByText('Warning')).toBeInTheDocument();
    expect(within(screen.getByTestId('efficiency-finding-input-pipeline')).getByText('Inconclusive')).toBeInTheDocument();
    // Low memory holds for the job even here: its GPUs cannot be fuller than the fullest GPU of the node.
    expect(within(screen.getByTestId('efficiency-finding-gpu-memory')).getByText('Warning')).toBeInTheDocument();
  });

  it('accuses the job of nothing when one of its nodes has no GPU telemetry', async () => {
    // GPUs 4-7 of gpu-node001 are idle, but the job may hold GPUs 0-3 of each node.
    const job = makeJob({ nodes: ['gpu-node001', 'gpu-node002'], nodeList: 'gpu-node[001-002]', nodeCount: 2 });
    renderState({ status: 'done', result: await scoreWith(halfIdleMetrics(4), job) });

    for (const tile of ['time-in-use', 'idle-gpu-hours', 'never-active-gpus', 'peak-gpu-memory']) {
      expect(within(screen.getByTestId(`efficiency-tile-${tile}`)).getByText('Unknown')).toBeInTheDocument();
    }
    for (const finding of ['idle-gpus', 'idle-gpu-time', 'gpu-memory', 'input-pipeline']) {
      expect(within(screen.getByTestId(`efficiency-finding-${finding}`)).getByText('Inconclusive')).toBeInTheDocument();
    }
    expect(screen.queryByText('Warning')).not.toBeInTheDocument();
    expect(screen.queryByText('Advice:')).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId('efficiency-finding-idle-gpus')).getByText(/^Node gpu-node002 of the job reports no GPU telemetry/)
    ).toBeInTheDocument();

    // The rows are the GPUs of the node, not the job's, and the table says so.
    expect(screen.queryByRole('button', { name: 'Per-GPU evidence (8)' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: "GPUs reporting on the job's nodes (8)" }));
    expect(screen.getByText(/The telemetry cannot tell which of them belong to the job/)).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(9);
  });

  it('gives a warning, an OK and an inconclusive finding different badges', () => {
    expect(SEVERITY_BADGE).toEqual({
      warning: { color: 'orange', icon: 'exclamation-triangle' },
      ok: { color: 'green', icon: 'check-circle' },
      unknown: { color: 'blue', icon: 'question-circle' },
    });
  });

  it('marks an idle GPU as a warning only when the GPU is the job own', () => {
    expect(activityBadge('idle', true)).toEqual({ text: 'Idle', color: 'orange', icon: 'exclamation-triangle' });
    expect(activityBadge('idle', false)).toEqual({ text: 'Idle', color: 'blue', icon: 'info-circle' });
    expect(activityBadge('active', false)).toEqual(activityBadge('active', true));
    expect(activityBadge('partial', true)).toEqual({ text: 'Gaps in telemetry', color: 'blue', icon: 'question-circle' });
  });

  it('says that a running job is scored up to now and offers to score it again', async () => {
    const now = START + 30 * 60;
    const result = await scoreWith(halfIdleMetrics(8), makeJob({ state: 'RUNNING', endTime: 0 }), now);
    const onRetry = renderState({ status: 'done', result });

    expect(screen.getByText('The job is still running: the scores cover the time up to now and will change.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Score again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('reports missing telemetry as no data, not as idle GPUs', async () => {
    renderState({ status: 'done', result: await scoreWith(new FakeMetrics()) });

    expect(screen.getByText('No data')).toBeInTheDocument();
    expect(
      screen.getByText(
        "DCGM_FI_DEV_GPU_UTIL has no series for the job's nodes in the scored window, so nothing was scored. Missing telemetry does not mean that the GPUs were idle."
      )
    ).toBeInTheDocument();
    expect(screen.queryByTestId('efficiency-tile-idle-gpu-hours')).not.toBeInTheDocument();
    expect(screen.queryByText('Warning')).not.toBeInTheDocument();
  });

  it.each([
    [makeJob({ gpusTotal: 0 }), "The job's AllocTRES records no GPUs, so there is no GPU allocation to compare the telemetry with."],
    [makeJob({ endTime: START + 120 }), 'The job ran for 2m. Jobs shorter than 5m hold too few samples to score.'],
    [makeJob({ state: 'PENDING', startTime: 0, endTime: 0 }), 'The job has not started.'],
    [
      makeJob({ suspendedSeconds: 900 }),
      'The job was suspended for 15m of its run. A suspended job keeps its allocation but does not run, and its GPUs may run another job meanwhile. slurmdbd does not record when the job was suspended, so its telemetry cannot be scored against its allocation.',
    ],
  ])('explains why a job is not scored', async (job, message) => {
    renderState({ status: 'done', result: await scoreWith(halfIdleMetrics(0), job) });

    expect(screen.getByText('Not scored')).toBeInTheDocument();
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.queryByTestId('efficiency-tile-idle-gpu-hours')).not.toBeInTheDocument();
  });

  it('names the setting to change when the GPU label is missing', () => {
    renderState({ status: 'done', result: { kind: 'not-computed', reason: 'missing-gpu-label', settings: { ...EFFICIENCY_DEFAULTS, gpuIdLabel: 'minor_number' } } });

    expect(screen.getByText(/has no "minor_number" label on the job's nodes/)).toBeInTheDocument();
  });

  it('shows a failed query with a retry button', () => {
    const onRetry = renderState({ status: 'error', message: 'Metrics query failed (HTTP 502)' });

    expect(screen.getByText('Job efficiency could not be scored')).toBeInTheDocument();
    expect(screen.getByText('Metrics query failed (HTTP 502)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('JobEfficiencySection', () => {
  beforeEach(() => {
    mockCreateDatasourceClient.mockReset();
  });

  it('scores the job through the cluster datasource and shows the result', async () => {
    const metrics = halfIdleMetrics(4);
    mockCreateDatasourceClient.mockReturnValue(metrics);

    render(<JobEfficiencySection job={makeJob()} cluster={cluster} />);

    expect(screen.getByText('Scoring job efficiency...')).toBeInTheDocument();
    expect(await screen.findByTestId('efficiency-finding-idle-gpus')).toBeInTheDocument();
    expect(mockCreateDatasourceClient).toHaveBeenCalledWith('prom-main');
    expect(metrics.queries).toHaveLength(8);
  });

  it('shows the error of a failed query and scores again on retry', async () => {
    mockCreateDatasourceClient
      .mockReturnValueOnce(new FakeMetrics({ failOn: /GPU_UTIL/ }))
      .mockReturnValueOnce(halfIdleMetrics(8));

    render(<JobEfficiencySection job={makeJob()} cluster={cluster} />);

    expect(await screen.findByText('Metrics query failed (HTTP 500: fake failure)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.getByTestId('efficiency-finding-idle-gpus')).toBeInTheDocument());
    expect(within(screen.getByTestId('efficiency-finding-idle-gpus')).getByText('OK')).toBeInTheDocument();
  });

  it('does not query for a job without allocated GPUs', async () => {
    const metrics = halfIdleMetrics(0);
    mockCreateDatasourceClient.mockReturnValue(metrics);

    render(<JobEfficiencySection job={makeJob({ gpusTotal: 0 })} cluster={cluster} />);

    expect(await screen.findByText('Not scored')).toBeInTheDocument();
    expect(metrics.queries).toHaveLength(0);
  });

  it('ignores the result of a job that is no longer shown', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = halfIdleMetrics(0);
    const original = slow.range.bind(slow);
    slow.range = async (...args) => {
      await gate;
      return original(...args);
    };
    mockCreateDatasourceClient.mockReturnValueOnce(slow).mockReturnValueOnce(halfIdleMetrics(8));

    const { rerender } = render(<JobEfficiencySection job={makeJob({ jobId: 1 })} cluster={cluster} />);
    rerender(<JobEfficiencySection job={makeJob({ jobId: 2 })} cluster={cluster} />);

    await waitFor(() => expect(within(screen.getByTestId('efficiency-finding-idle-gpus')).getByText('OK')).toBeInTheDocument());
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The first job had only idle GPUs; its late result must not replace the second job's.
    expect(within(screen.getByTestId('efficiency-finding-idle-gpus')).getByText('OK')).toBeInTheDocument();
  });
  it('stops querying when the section is unmounted', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = halfIdleMetrics(4);
    const original = slow.range.bind(slow);
    slow.range = async (...args) => {
      const series = await original(...args);
      await gate;
      return series;
    };
    mockCreateDatasourceClient.mockReturnValue(slow);

    const { unmount } = render(<JobEfficiencySection job={makeJob()} cluster={cluster} />);
    await waitFor(() => expect(slow.queries).toHaveLength(1));
    unmount();
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The first query was in flight; the other seven are never sent.
    expect(slow.queries).toHaveLength(1);
  });
});
