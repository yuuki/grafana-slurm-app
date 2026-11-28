import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ClusterSummary, JobRecord, PhaseSettings } from '../../../api/types';
import { JobPhasesSection } from './JobPhasesSection';
import { MetricsClient, MetricsQueryError } from '../phases/promClient';
import { buildQueryContext } from '../phases/queries';
import { resolvePhaseSettings } from '../phases/settings';
import { createFakeMetricsClient, FakeMetricsClient } from '../phases/__fixtures__/fakeMetrics';
import { generateSyntheticJob, SyntheticJobSpec, SyntheticStage, syntheticSpec } from '../phases/__fixtures__/syntheticJob';

// The section queries through an injected client in these tests; the real runtime does not load beside a mocked @grafana/ui.
jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({ fetch: jest.fn() }),
}));

jest.mock('@grafana/ui', () => {
  const React = require('react');
  return {
    Alert: ({ title, severity, children }: { title: string; severity?: string; children?: React.ReactNode }) => (
      <div role="alert" data-severity={severity}>
        <span>{title}</span>
        <span>{children}</span>
      </div>
    ),
    Button: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => (
      <button type="button" onClick={onClick} disabled={disabled}>
        {children}
      </button>
    ),
    CollapsableSection: ({ label, isOpen, children }: { label: string; isOpen?: boolean; children: React.ReactNode }) => {
      const [open, setOpen] = React.useState(!!isOpen);
      return (
        <div>
          <button type="button" onClick={() => setOpen((current: boolean) => !current)}>
            {label}
          </button>
          {open ? children : null}
        </div>
      );
    },
    LoadingPlaceholder: ({ text }: { text: string }) => <div>{text}</div>,
    useStyles2: (getStyles: (theme: unknown) => unknown) =>
      getStyles({
        colors: {
          border: { medium: '#ccc', weak: '#ddd' },
          background: { primary: '#fff', secondary: '#f5f5f5', canvas: '#eee' },
          text: { primary: '#111', secondary: '#666' },
        },
      }),
    useTheme2: () => ({ isDark: false }),
  };
});

const MINUTE = 60;
const stage = (phase: SyntheticStage['phase'], minutes: number): SyntheticStage => ({ phase, seconds: minutes * MINUTE });
const STAGES = [stage('init', 6), stage('compute', 30), stage('checkpoint', 3), stage('compute', 30), stage('stalled', 20)];

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
  phases: { enabled: true },
};

interface Setup {
  job: JobRecord;
  cluster: ClusterSummary;
  client: FakeMetricsClient;
  now: () => number;
}

function setup(spec: SyntheticJobSpec, overrides: { job?: Partial<JobRecord>; phases?: PhaseSettings | undefined } = {}): Setup {
  const synthetic = generateSyntheticJob(spec);
  const nodes = Array.from({ length: spec.nodeCount }, (_, index) => `node-a00${index + 1}`);
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
  const cluster = { ...baseCluster, ...('phases' in overrides ? { phases: overrides.phases } : {}) };
  const resolved = resolvePhaseSettings({ enabled: true });
  if (resolved.state !== 'on') {
    throw new Error('expected valid settings');
  }
  const client = createFakeMetricsClient({ job: synthetic, nodeNames: nodes, settings: resolved.settings, context: buildQueryContext(nodes, cluster) });
  const nowSec = synthetic.endSec + 3600;
  return { job, cluster, client, now: () => nowSec };
}

async function renderReady(item: Setup, props: Partial<React.ComponentProps<typeof JobPhasesSection>> = {}) {
  const view = render(<JobPhasesSection job={item.job} cluster={item.cluster} hookOptions={{ client: item.client, now: item.now }} {...props} />);
  await screen.findByRole('img', { name: /Share of the analysed window/ });
  return view;
}

describe('JobPhasesSection', () => {
  it('renders nothing and sends no query when the cluster does not turn the feature on', async () => {
    for (const phases of [undefined, {}, { enabled: false }, { enabled: false, stallMinutes: 20 }] as Array<PhaseSettings | undefined>) {
      const item = setup(syntheticSpec(STAGES), { phases });
      const { container, unmount } = render(<JobPhasesSection job={item.job} cluster={item.cluster} hookOptions={{ client: item.client, now: item.now }} />);
      await act(async () => {});
      expect(container).toBeEmptyDOMElement();
      expect(item.client.calls).toEqual([]);
      unmount();
    }
  });

  it('shows the breakdown with shares that add up, and the timeline', async () => {
    const item = setup(syntheticSpec(STAGES));
    await renderReady(item);

    const legend = screen.getByRole('list', { name: 'Time per phase' });
    const items = within(legend).getAllByRole('listitem').map((entry) => entry.textContent);
    expect(items).toEqual(['6.8%Startup6m', '68.2%Compute + collective1h', '3.4%Checkpoint / storage I/O3m', '21.6%Stalled (GPUs idle)19m']);
    expect(screen.getByRole('img', { name: /Share of the analysed window/ })).toHaveAccessibleName(
      'Share of the analysed window: 6.8% Startup, 68.2% Compute + collective, 3.4% Checkpoint / storage I/O, 21.6% Stalled (GPUs idle)'
    );

    const segments = screen.getAllByTestId('phase-segment');
    expect(segments.map((segment) => segment.getAttribute('data-phase'))).toEqual(['init', 'compute', 'checkpoint', 'compute', 'stalled']);
    // The widths are in proportion to the lengths of the stretches, in time order: 6, 30, 3, 30 and 19 minutes.
    expect(segments.map((segment) => parseFloat(segment.style.flexGrow) / 60)).toEqual([6, 30, 3, 30, 19]);

    const covers = screen.getByRole('list', { name: 'What the result covers' });
    expect(covers).toHaveTextContent('in 88 buckets of 1m (scrape interval 15 s)');
    expect(covers).toHaveTextContent('A stretch shorter than about one bucket is not visible');
    expect(covers).toHaveTextContent('1m at the edges of the run is outside the buckets and not analysed.');
    expect(item.client.calls).toHaveLength(8);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('names the stretch under the pointer and zooms the panels to a clicked stretch', async () => {
    const item = setup(syntheticSpec(STAGES));
    const onZoom = jest.fn();
    await renderReady(item, { onZoom });
    const readout = screen.getByTestId('phase-readout');
    expect(readout).toHaveTextContent('Click a stretch to zoom the panels to it.');

    const checkpoint = screen.getAllByTestId('phase-segment')[2];
    fireEvent.mouseEnter(checkpoint);
    expect(readout).toHaveTextContent(/· 3m · Checkpoint \/ storage I\/O$/);

    fireEvent.click(checkpoint);
    expect(onZoom).toHaveBeenCalledTimes(1);
    const [fromMs, toMs] = onZoom.mock.calls[0];
    expect(toMs - fromMs).toBe(3 * MINUTE * 1000);
    expect(fromMs % 60000).toBe(0);

    fireEvent.mouseLeave(checkpoint.parentElement!);
    expect(readout).toHaveTextContent('Hover the timeline to read a stretch.');
  });

  it('offers no zoom while no panel is shown', async () => {
    const item = setup(syntheticSpec(STAGES));
    await renderReady(item);
    expect(screen.getByTestId('phase-readout')).toHaveTextContent('Pin a metric to zoom its panel to a stretch.');
    fireEvent.click(screen.getByRole('button', { name: 'Stretches (5)' }));
    for (const button of screen.getAllByRole('button', { name: 'Zoom' })) {
      expect(button).toBeDisabled();
    }
  });

  it('lists every stretch in a table and hands a stretch to the label dialog only on request', async () => {
    const item = setup(syntheticSpec(STAGES));
    const onDraftLabel = jest.fn();
    const onZoom = jest.fn();
    await renderReady(item, { onDraftLabel, onZoom });
    fireEvent.click(screen.getByRole('button', { name: 'Stretches (5)' }));

    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(5);
    expect(rows[2]).toHaveTextContent('Checkpoint / storage I/O');
    expect(onDraftLabel).not.toHaveBeenCalled();

    fireEvent.click(within(rows[2]).getByRole('button', { name: 'Label…' }));
    expect(onDraftLabel).toHaveBeenCalledTimes(1);
    const draft = onDraftLabel.mock.calls[0][0];
    expect(draft.category).toBe('phase-checkpoint');
    expect(draft.note).toBe('Detected by the job phase segmentation: Checkpoint / storage I/O. Review the window before saving.');
    expect(draft.toMs - draft.fromMs).toBe(3 * MINUTE * 1000);

    fireEvent.click(within(rows[4]).getByRole('button', { name: 'Zoom' }));
    expect(onZoom).toHaveBeenCalledWith(expect.any(Number), expect.any(Number));
  });

  it('offers no label action when annotation labeling is off', async () => {
    const item = setup(syntheticSpec(STAGES));
    await renderReady(item);
    fireEvent.click(screen.getByRole('button', { name: 'Stretches (5)' }));
    expect(screen.queryByRole('button', { name: 'Label…' })).not.toBeInTheDocument();
  });

  it('shows the telemetry of each phase and what the result is based on', async () => {
    const item = setup(syntheticSpec(STAGES));
    await renderReady(item);
    fireEvent.click(screen.getByRole('button', { name: 'Phase details and telemetry' }));
    const stalled = screen.getAllByRole('row').find((row) => row.textContent?.startsWith('Stalled'));
    expect(stalled).toHaveTextContent('19m');
    expect(stalled).toHaveTextContent('21.6%');
    expect(stalled).toHaveTextContent('60 W');
    expect(stalled).toHaveTextContent('0.4%');
    expect(screen.getByText(/Network is shown as evidence and decides no phase/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'What the phases are based on' }));
    expect(screen.getByText('DCGM_FI_DEV_POWER_USAGE')).toBeInTheDocument();
    expect(screen.getByText('node_disk_written_bytes_total')).toBeInTheDocument();
    expect(screen.getAllByText('used, 100% of node buckets')).toHaveLength(5);
    expect(screen.getByText(/A stall needs every GPU idle for 10m/)).toBeInTheDocument();
    expect(screen.getByText(/A write burst needs 1.0 MiB\/s over the job's nodes/)).toBeInTheDocument();
  });

  it('says what the result is based on when the cluster has no disk series, and shows no checkpoint', async () => {
    const item = setup(syntheticSpec(STAGES, { without: ['storageWrite'] }));
    await renderReady(item);
    const legend = within(screen.getByRole('list', { name: 'Time per phase' })).getAllByRole('listitem').map((entry) => entry.textContent);
    expect(legend.some((text) => text?.includes('Checkpoint'))).toBe(false);
    expect(legend.some((text) => text?.includes('Unclassified'))).toBe(true);
    expect(screen.getByRole('list', { name: 'What the result covers' })).toHaveTextContent(
      'Without a storage write series, no checkpoint is reported: GPU dips stay unclassified.'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Phase details and telemetry' }));
    expect(screen.getByText('GPUs below the working level; the storage write rate is unknown, so a checkpoint cannot be told')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'What the phases are based on' }));
    expect(screen.getByText('no series')).toBeInTheDocument();
  });

  it('names a node that stalls while the job computes', async () => {
    const item = setup(syntheticSpec(STAGES, { nodeCount: 4, stalledNodes: [{ node: 2, fromSec: 10 * MINUTE }] }));
    await renderReady(item);
    expect(screen.getByRole('list', { name: 'What the result covers' })).toHaveTextContent(/node-a003: GPUs idle for 2\dm from .*, while the job computed/);
  });

  it('warns when a running job is stalled now', async () => {
    const item = setup(syntheticSpec(STAGES), { job: { endTime: 0, state: 'RUNNING' } });
    const synthetic = generateSyntheticJob(syntheticSpec(STAGES));
    render(<JobPhasesSection job={item.job} cluster={item.cluster} hookOptions={{ client: item.client, now: () => synthetic.endSec }} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('data-severity', 'warning');
    expect(alert).toHaveTextContent(/Stalled now: every GPU of the job has been idle for 1\dm/);
    expect(screen.getByRole('list', { name: 'What the result covers' })).toHaveTextContent('The job is running: the result covers it up to');
  });

  it('gives no phases, with the reason, for a job that is too short', async () => {
    const item = setup(syntheticSpec([{ phase: 'compute', seconds: 135 }]));
    render(<JobPhasesSection job={item.job} cluster={item.cluster} hookOptions={{ client: item.client, now: item.now }} />);
    expect(await screen.findByText('No phases for this job. The job is too short: the phases need at least 5 buckets of 1m inside the run.')).toBeInTheDocument();
    expect(item.client.calls).toEqual([]);
    expect(screen.queryByTestId('phase-segment')).not.toBeInTheDocument();
  });

  it('gives no phases for a job on nodes that hold GPUs of other jobs', async () => {
    const item = setup(syntheticSpec(STAGES, { gpusPerNode: 8 }), { job: { gpusTotal: 4 } });
    render(<JobPhasesSection job={item.job} cluster={item.cluster} hookOptions={{ client: item.client, now: item.now }} />);
    expect(await screen.findByText(/The job's nodes report 16 GPUs and the job allocated 4\./)).toBeInTheDocument();
    expect(item.client.calls).toHaveLength(1);
  });

  it('reports a failed query as an error and retries on request', async () => {
    const item = setup(syntheticSpec(STAGES));
    let fail = true;
    const flaky: MetricsClient = {
      instant: (expr, time) => (fail ? Promise.reject(new MetricsQueryError('HTTP 502')) : item.client.instant(expr, time)),
      range: (expr, start, end, step) => item.client.range(expr, start, end, step),
    };
    render(<JobPhasesSection job={item.job} cluster={item.cluster} hookOptions={{ client: flaky, now: item.now }} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The job phases could not be analysed');
    expect(alert).toHaveTextContent('Metrics query failed (HTTP 502)');
    expect(screen.queryByTestId('phase-segment')).not.toBeInTheDocument();

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('img', { name: /Share of the analysed window/ });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('sends no query for invalid settings and says so', async () => {
    const item = setup(syntheticSpec(STAGES), { phases: { enabled: true, gpuUtilizationMetric: 'up{} or vector(1)' } });
    render(<JobPhasesSection job={item.job} cluster={item.cluster} hookOptions={{ client: item.client, now: item.now }} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The phase settings of this cluster are not valid. No query was sent.');
    expect(alert).toHaveTextContent('GPU Utilization Metric must be a Prometheus metric name');
    expect(item.client.calls).toEqual([]);
  });

  it('reports a cluster without a metrics datasource as an error, without a query', async () => {
    const item = setup(syntheticSpec(STAGES));
    render(<JobPhasesSection job={item.job} cluster={{ ...item.cluster, metricsDatasourceUid: '' }} hookOptions={{ now: item.now }} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The job phases could not be analysed');
    expect(alert).toHaveTextContent('The cluster has no metrics datasource.');
  });

  it('runs the analysis again on Refresh', async () => {
    const item = setup(syntheticSpec(STAGES));
    await renderReady(item);
    expect(item.client.calls).toHaveLength(8);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(item.client.calls).toHaveLength(16));
    await screen.findByRole('img', { name: /Share of the analysed window/ });
  });

  it('stops sending queries when it is unmounted', async () => {
    const item = setup(syntheticSpec(STAGES));
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: MetricsClient = {
      instant: async (expr, time) => {
        await gate;
        return item.client.instant(expr, time);
      },
      range: (expr, start, end, step) => item.client.range(expr, start, end, step),
    };
    const { unmount } = render(<JobPhasesSection job={item.job} cluster={item.cluster} hookOptions={{ client: slow, now: item.now }} />);
    expect(await screen.findByText(/Reading the job's telemetry \(query 1 of at most 8\)/)).toBeInTheDocument();
    unmount();
    await act(async () => {
      release();
      await gate;
    });
    await act(async () => {});
    // The probe that was under way returns; nothing follows it.
    expect(item.client.calls).toHaveLength(1);
  });
});
