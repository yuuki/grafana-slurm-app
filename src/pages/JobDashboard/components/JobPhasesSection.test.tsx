import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ClusterSummary, JobRecord, PhaseSettings } from '../../../api/types';
import { JobPhasesSection, MAX_STRETCH_ROWS, timelinePosition } from './JobPhasesSection';
import { MetricsClient, MetricsQueryError } from '../phases/promClient';
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
  const client = createFakeMetricsClient({ job: synthetic, nodeNames: nodes, settings: resolved.settings, cluster });
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
    // Each stretch starts at its place in time. The stretches last 6, 30, 3, 30 and 19 minutes of 88.
    const starts = segments.map((segment) => (parseFloat(segment.style.left) * 88) / 100);
    [0, 6, 36, 39, 69].forEach((minute, index) => expect(starts[index]).toBeCloseTo(minute, 9));

    const covers = screen.getByRole('list', { name: 'What the result covers' });
    expect(covers).toHaveTextContent('in 88 buckets of 1m (GPU and CPU scrape interval 15 s)');
    expect(covers).toHaveTextContent('A stretch shorter than about one bucket is not visible');
    expect(covers).toHaveTextContent('1m at the edges of the run is outside the buckets and not analysed.');
    expect(item.client.calls).toHaveLength(10);
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

  describe('a job with more stretches than a narrow strip has pixels', () => {
    // GPU work and waiting alternate every minute for ten hours: several hundred stretches of a 600th of the window.
    const flicker: SyntheticStage[] = [];
    for (let i = 0; i < 300; i++) {
      flicker.push({ phase: 'compute', seconds: MINUTE }, { phase: 'gap', seconds: MINUTE });
    }
    const spec = syntheticSpec(flicker, { nodeCount: 1, gpusPerNode: 1 });
    const stretchCount = () => Number(/Timeline of (\d+) stretches/.exec(screen.getByRole('img', { name: /^Timeline of/ }).getAttribute('aria-label')!)![1]);

    it('keeps every block at its true position in time, with no smallest width, so the strip ends where the window ends', async () => {
      const item = setup(spec);
      await renderReady(item);
      const count = stretchCount();
      expect(count).toBeGreaterThan(250);
      const blocks = screen.getAllByTestId('phase-segment');
      // Every stretch is in exactly one block, and runs of short stretches share a block.
      expect(blocks.reduce((sum, block) => sum + Number(block.getAttribute('data-stretches')), 0)).toBe(count);
      expect(blocks.length).toBeLessThan(count);

      // A smallest width of one pixel per stretch pushed the last stretches out of a strip with fewer
      // pixels than stretches. A block has a start in percent of the window and no width of its own.
      const lefts = blocks.map((block) => parseFloat(block.style.left));
      expect(lefts[0]).toBe(0);
      lefts.slice(1).forEach((left, index) => expect(left).toBeGreaterThan(lefts[index]));
      expect(lefts[lefts.length - 1]).toBeLessThan(100);
      for (const block of blocks) {
        expect(block.style.left.endsWith('%')).toBe(true);
        expect(block.style.width).toBe('');
        expect(block.style.minWidth).toBe('');
        expect(block.style.flex).toBe('');
      }
    });

    it('draws a run of short stretches as one block with the shares of its phases, and says so', async () => {
      const item = setup(spec);
      await renderReady(item);
      const blocks = screen.getAllByTestId('phase-segment');
      const mixed = blocks.filter((block) => Number(block.getAttribute('data-stretches')) > 1);
      expect(mixed.length).toBeGreaterThan(0);
      const largest = mixed.sort((a, b) => Number(b.getAttribute('data-stretches')) - Number(a.getAttribute('data-stretches')))[0];
      expect(largest.getAttribute('data-phase')).toBe('compute unclassified');
      expect(largest.style.backgroundImage).toContain('linear-gradient(to top');
      fireEvent.mouseEnter(largest);
      expect(screen.getByTestId('phase-readout')).toHaveTextContent(/\d+ stretches, each too short to draw on its own: \d+\.\d% Compute \+ collective, \d+\.\d% Unclassified/);
      expect(screen.getByTestId('phase-merged-note')).toHaveTextContent('Neighbouring stretches that are each shorter than 1/360 of the window are drawn as one block.');
      expect(screen.getByTestId('phase-merged-note')).toHaveTextContent('they are not stretches');
    });

    it('zooms the panels to the whole block when a block of several stretches is clicked', async () => {
      const item = setup(spec);
      const onZoom = jest.fn();
      await renderReady(item, { onZoom });
      const mixed = screen.getAllByTestId('phase-segment').find((block) => Number(block.getAttribute('data-stretches')) > 10)!;
      fireEvent.click(mixed);
      const [fromMs, toMs] = onZoom.mock.calls[0];
      expect(toMs - fromMs).toBeGreaterThan(10 * MINUTE * 1000);
    });

    it('gives every stretch a row with its actions: the table has pages of 100, in time order', async () => {
      const item = setup(spec);
      const onZoom = jest.fn();
      const { container } = await renderReady(item, { onZoom, onDraftLabel: jest.fn() });
      const count = stretchCount();
      fireEvent.click(screen.getByRole('button', { name: `Stretches (${count})` }));
      const rowsOnPage = () => within(screen.getByRole('region', { name: 'Stretches' })).getAllByRole('row').slice(1);
      const pages = screen.getByTestId('phase-stretch-pages');
      const previous = screen.getByRole('button', { name: 'Previous 100' });
      const next = screen.getByRole('button', { name: 'Next 100' });

      expect(rowsOnPage()).toHaveLength(MAX_STRETCH_ROWS);
      expect(pages).toHaveTextContent(`Stretches 1 to 100 of ${count}, in time order.`);
      expect(previous).toBeDisabled();

      // Walk to the last page and count the rows: every stretch has exactly one, with Zoom and Label.
      let seen = 0;
      const firstCells: string[] = [];
      // At most 50 pages: a "Next" that never ends must fail the test, not hang it.
      for (let pageIndex = 0; pageIndex < 50; pageIndex++) {
        const rows = rowsOnPage();
        seen += rows.length;
        firstCells.push(rows[0].textContent ?? '');
        rows.forEach((row) => {
          expect(within(row).getByRole('button', { name: 'Zoom' })).toBeEnabled();
          expect(within(row).getByRole('button', { name: 'Label…' })).toBeInTheDocument();
        });
        if (next.hasAttribute('disabled')) {
          break;
        }
        fireEvent.click(next);
      }
      expect(seen).toBe(count);
      expect(new Set(firstCells).size).toBe(Math.ceil(count / MAX_STRETCH_ROWS));
      expect(pages).toHaveTextContent(`Stretches ${Math.floor((count - 1) / 100) * 100 + 1} to ${count} of ${count}, in time order.`);
      expect(previous).toBeEnabled();

      // The last stretch of the job is on the last page; its Zoom goes to its own window.
      const lastRow = rowsOnPage()[rowsOnPage().length - 1];
      fireEvent.click(within(lastRow).getByRole('button', { name: 'Zoom' }));
      const [fromMs, toMs] = onZoom.mock.calls[onZoom.mock.calls.length - 1];
      expect(toMs).toBeGreaterThan(fromMs);
      expect(toMs / 1000).toBe(item.job.endTime - (item.job.endTime % 60));

      fireEvent.click(previous);
      expect(pages).toHaveTextContent(new RegExp(`Stretches \\d+ to \\d+ of ${count}`));
      expect(container).not.toHaveTextContent(/shows all/i);
      expect(container).not.toHaveTextContent(/lists the first/i);
    });

    it('shows no paging for a job whose stretches fit on one page', async () => {
      const item = setup(syntheticSpec(STAGES));
      await renderReady(item);
      fireEvent.click(screen.getByRole('button', { name: 'Stretches (5)' }));
      expect(screen.queryByTestId('phase-stretch-pages')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Next 100' })).not.toBeInTheDocument();
    });
  });

  describe('labels that are too small to see on the bar', () => {
    // Twelve hours of compute with a one-minute checkpoint every two hours: each checkpoint is 1/720 of the window.
    const long: SyntheticStage[] = [stage('init', 30)];
    for (let i = 0; i < 6; i++) {
      long.push(stage('compute', 119), stage('checkpoint', 1));
    }
    long.push(stage('compute', 30));

    it('marks every checkpoint above the bar at its place, with a fixed width, and says what a mark is', async () => {
      const item = setup(syntheticSpec(long, { nodeCount: 1, gpusPerNode: 1 }));
      await renderReady(item);
      const lanes = screen.getAllByTestId('phase-marker-lane');
      const checkpointLane = lanes.find((lane) => lane.getAttribute('data-phase') === 'checkpoint')!;
      const markers = within(checkpointLane).getAllByTestId('phase-marker');
      // One mark per checkpoint block of the bar.
      const blocks = screen.getAllByTestId('phase-segment').filter((block) => block.getAttribute('data-phase') === 'checkpoint');
      expect(blocks.length).toBeGreaterThanOrEqual(5);
      expect(markers).toHaveLength(blocks.length);
      // A mark sits at the centre of its block: a little after the block's start, which the bar gives in percent.
      markers.forEach((marker, index) => {
        const [, percent, pixels] = /^calc\(([\d.]+)% - ([\d.]+)px\)$/.exec(marker.style.left)!;
        const center = Number(percent);
        const blockStart = parseFloat(blocks[index].style.left);
        expect(center).toBeGreaterThan(blockStart);
        expect(center - blockStart).toBeLessThan(0.2);
        // Inside the strip at both ends: the left edge runs from 0 to the strip width less the mark width (3 px).
        expect(Number(pixels)).toBeCloseTo((center * 3) / 100, 4);
      });
      // The legend lists the label, and the note names it and says that a mark is not a length.
      expect(screen.getByRole('list', { name: 'Time per phase' })).toHaveTextContent('Checkpoint / storage I/O');
      const note = screen.getByTestId('phase-marker-note');
      expect(note).toHaveTextContent('Checkpoint / storage I/O');
      expect(note).toHaveTextContent('A mark has a fixed width: it shows a place, not a length.');
      // The long compute blocks need no mark.
      expect(lanes.some((lane) => lane.getAttribute('data-phase') === 'compute')).toBe(false);
    });

    it('shows no marks for a job whose stretches are all wide enough', async () => {
      const item = setup(syntheticSpec(STAGES));
      await renderReady(item);
      expect(screen.queryByTestId('phase-marker-lane')).not.toBeInTheDocument();
      expect(screen.queryByTestId('phase-marker-note')).not.toBeInTheDocument();
    });
  });

  it('says why the phases are off when the backend dropped invalid settings that asked for them, and sends no query', async () => {
    const item = setup(syntheticSpec(STAGES), { phases: undefined });
    const cluster = { ...item.cluster, phasesError: 'phases stallMinutes must be between 1 and 1440' };
    render(<JobPhasesSection job={item.job} cluster={cluster} hookOptions={{ client: item.client, now: item.now }} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Job phases are off for this cluster: its phase settings are not valid. No query was sent.');
    expect(alert).toHaveTextContent('phases stallMinutes must be between 1 and 1440. An administrator can correct the Job Phases settings');
    await act(async () => {});
    expect(item.client.calls).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
  });

  it('shows no note about merged stretches for a job whose stretches are all long enough to draw', async () => {
    const item = setup(syntheticSpec(STAGES));
    await renderReady(item);
    expect(screen.queryByTestId('phase-merged-note')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('phase-segment').every((block) => block.getAttribute('data-stretches') === '1')).toBe(true);
  });

  it('places a stretch by its time alone', () => {
    expect(timelinePosition({ phase: 'compute', fromSec: 1000, toSec: 1060 }, 1000, 1600)).toEqual({ leftPercent: 0, widthPercent: 10 });
    expect(timelinePosition({ phase: 'stalled', fromSec: 1540, toSec: 1600 }, 1000, 1600)).toEqual({ leftPercent: 90, widthPercent: 10 });
    // A stretch of one minute in a day: far under a pixel on any screen, and still at its place.
    const tiny = timelinePosition({ phase: 'checkpoint', fromSec: 43_200, toSec: 43_260 }, 0, 86_400);
    expect(tiny.leftPercent).toBe(50);
    expect(tiny.widthPercent).toBeCloseTo(100 / 1440, 10);
  });

  it('puts every table into a region that scrolls sideways inside the section', async () => {
    const item = setup(syntheticSpec(STAGES));
    await renderReady(item, { onZoom: jest.fn() });
    fireEvent.click(screen.getByRole('button', { name: 'Stretches (5)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Phase details and telemetry' }));
    fireEvent.click(screen.getByRole('button', { name: 'What the phases are based on' }));
    const tables = screen.getAllByRole('table');
    expect(tables.length).toBeGreaterThanOrEqual(3);
    for (const table of tables) {
      const region = table.parentElement!;
      expect(region).toHaveAttribute('role', 'region');
      expect(region).toHaveAttribute('aria-label');
      // Reachable with the keyboard, so that it can be scrolled without a mouse.
      expect(region).toHaveAttribute('tabindex', '0');
    }
  });

  it('offers no label for a stretch without GPU data', async () => {
    // Every exporter is silent for ten minutes in the middle of the compute phase.
    const item = setup(syntheticSpec(STAGES, { gaps: [{ node: 'all', fromSec: 15 * MINUTE, toSec: 25 * MINUTE }] }));
    await renderReady(item, { onDraftLabel: jest.fn(), onZoom: jest.fn() });
    fireEvent.click(screen.getByRole('button', { name: /^Stretches \(\d+\)$/ }));
    const rows = screen.getAllByRole('row').slice(1);
    const noData = rows.filter((row) => row.textContent?.includes('No GPU data'));
    expect(noData).toHaveLength(1);
    expect(within(noData[0]).getByRole('button', { name: 'Zoom' })).toBeInTheDocument();
    expect(within(noData[0]).queryByRole('button', { name: 'Label…' })).not.toBeInTheDocument();
    const others = rows.filter((row) => !row.textContent?.includes('No GPU data'));
    others.forEach((row) => expect(within(row).getByRole('button', { name: 'Label…' })).toBeInTheDocument());
  });

  it('says for a stalled stretch how long every GPU was idle, the CPU load and the storage writes', async () => {
    const item = setup(syntheticSpec(STAGES));
    await renderReady(item);
    fireEvent.click(screen.getByRole('button', { name: 'Stretches (5)' }));
    const stalled = screen.getAllByRole('row').find((row) => row.textContent?.includes('Stalled (GPUs idle)'))!;
    expect(stalled).toHaveTextContent(/Every reporting GPU idle for (19|20)m; CPU load of the busiest node 0\.\d%; no storage write burst \(median [\d.]+ (B|KiB)\/s\)\./);
    // The same sentence is in the readout of the timeline.
    const block = screen.getAllByTestId('phase-segment').find((element) => element.getAttribute('data-phase') === 'stalled')!;
    fireEvent.mouseEnter(block);
    expect(screen.getByTestId('phase-readout')).toHaveTextContent(/Stalled \(GPUs idle\) · Every reporting GPU idle for (19|20)m; CPU load of the busiest node/);
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
    // The power is printed without a unit: the metric is configurable, and "any unit works".
    expect(within(stalled!).getAllByRole('cell')[4]).toHaveTextContent(/^60$/);
    expect(screen.getByRole('region', { name: 'Phases with their telemetry' })).not.toHaveTextContent(/\d W\b/);
    expect(stalled).toHaveTextContent('0.4%');
    expect(screen.getByText(/Network is shown as evidence and decides no phase/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'What the phases are based on' }));
    expect(screen.getByText('DCGM_FI_DEV_POWER_USAGE')).toBeInTheDocument();
    expect(screen.getByText('node_disk_written_bytes_total')).toBeInTheDocument();
    expect(screen.getAllByText('used, 100% of node buckets')).toHaveLength(5);
    expect(screen.getByText(/A stall needs every GPU idle for 10m/)).toBeInTheDocument();
    expect(screen.getByText(/A write burst needs 1.0 MiB\/s on at least one node \(the configured minimum\)/)).toBeInTheDocument();
    expect(screen.getByText(/An idle stretch of the stall time is never a checkpoint when the CPUs are idle/)).toBeInTheDocument();
    expect(screen.getByText(/the CPU load of the busiest node \(its median\s+over the stretch\) below/)).toBeInTheDocument();
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
    expect(screen.getByText('GPUs below the working level, or idle for less than the stall time; the storage write rate is unknown, so a checkpoint cannot be told')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'What the phases are based on' }));
    expect(screen.getByText('no series')).toBeInTheDocument();
  });

  it('names a node that stalls while the job computes', async () => {
    const item = setup(syntheticSpec(STAGES, { nodeCount: 4, stalledNodes: [{ node: 2, fromSec: 10 * MINUTE }] }));
    await renderReady(item);
    expect(screen.getByRole('list', { name: 'What the result covers' })).toHaveTextContent(/node-a003: GPUs idle for 2\dm from .*, while other nodes of the job worked/);
  });

  it('warns when a running job is stalled now', async () => {
    const item = setup(syntheticSpec(STAGES), { job: { endTime: 0, state: 'RUNNING' } });
    const synthetic = generateSyntheticJob(syntheticSpec(STAGES));
    render(<JobPhasesSection job={item.job} cluster={item.cluster} hookOptions={{ client: item.client, now: () => synthetic.endSec }} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('data-severity', 'warning');
    expect(alert).toHaveTextContent(/Stalled now: every GPU of the job has been idle for 1\dm/);
    // The warning states what was seen in the idle run, with the storage writes.
    expect(alert).toHaveTextContent(/Slurm records the job as running\. Every reporting GPU idle for 1\dm; CPU load of the busiest node 0\.\d%; no storage write burst/);
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
    // Only the GPU probes were sent: no range query reads telemetry that is not the job's.
    expect(item.client.calls.map((call) => call.kind)).toEqual(['instant', 'instant', 'instant']);
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
    expect(item.client.calls).toHaveLength(10);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(item.client.calls).toHaveLength(20));
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
    expect(await screen.findByText(/Reading the job's telemetry \(query 1\)/)).toBeInTheDocument();
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
