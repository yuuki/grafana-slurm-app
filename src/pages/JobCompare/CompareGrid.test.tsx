import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { JobRecord } from '../../api/types';
import { CompareGrid } from './CompareGrid';
import { buildCompareView } from './compareView';
import { DEFAULT_VIEW_STATE } from './model';
import { JobSeries } from './seriesTransform';

const NOW = 100_000;

function makeJob(jobId: number, state = 'COMPLETED', endTime = 17_200): JobRecord {
  return {
    clusterId: 'a100',
    jobId,
    name: `train-${jobId}`,
    user: 'alice',
    account: 'ml',
    partition: 'gpu',
    state,
    nodes: ['n1'],
    nodeList: 'n1',
    nodeCount: 1,
    gpusTotal: 8,
    submitTime: 10_000,
    startTime: 10_000,
    endTime,
    exitCode: 0,
    workDir: '/tmp',
    tres: '',
    templateId: 'overview',
  };
}

function flat(value: number, end = 17_200): JobSeries {
  const times: number[] = [];
  for (let t = 10_000; t <= end; t += 600) {
    times.push(t);
  }
  return { times, mean: times.map(() => value), min: times.map(() => value), max: times.map(() => value) };
}

function renderGrid(overrides: Partial<typeof DEFAULT_VIEW_STATE> = {}, extraJobs: JobRecord[] = []) {
  const jobs = [makeJob(1), makeJob(2), makeJob(3), makeJob(4), makeJob(5, 'FAILED'), ...extraJobs];
  const values = [60, 61, 59, 60, 20];
  const series = new Map(jobs.slice(0, 5).map((job, i) => [`a100-${job.jobId}`, flat(values[i])]));
  const state = { ...DEFAULT_VIEW_STATE, ...overrides };
  const model = buildCompareView({ jobs, series, failedJobKeys: new Set(['a100-6']), loading: false, view: state, now: NOW });
  const handlers = {
    onOpen: jest.fn(),
    onToggleSelect: jest.fn(),
    onSetBaseline: jest.fn(),
    onOpenDashboard: jest.fn(),
  };
  render(<CompareGrid model={model} state={state} {...handlers} />);
  return handlers;
}

describe('CompareGrid', () => {
  beforeEach(() => {
    jest
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue({ left: 0, width: 200, top: 0, height: 96 } as DOMRect);
  });

  afterEach(() => jest.restoreAllMocks());

  it('renders one cell per job with the outlier first and flagged', () => {
    renderGrid();
    const cells = screen.getAllByRole('group');
    expect(cells).toHaveLength(5);
    expect(cells[0]).toHaveAccessibleName('Job 5');
    expect(cells[0]).toHaveAttribute('data-flagged', 'true');
    expect(within(cells[0]).getByText(/-40\.0 vs\. median/)).toBeInTheDocument();
    expect(within(cells[0]).getByTestId('marker-abnormal-end')).toBeInTheDocument();
  });

  it('does not highlight deviation when sorted by something else', () => {
    renderGrid({ sort: 'job-id' });
    expect(screen.getAllByRole('group').some((cell) => cell.hasAttribute('data-flagged'))).toBe(false);
  });

  it('syncs the hover cursor across every cell', () => {
    renderGrid();
    const charts = screen.getAllByRole('img', { name: /^Series for job/ });
    fireEvent.mouseMove(charts[0], { clientX: 100 });
    expect(screen.getAllByText(/^1h 0m: /)).toHaveLength(5);
    expect(screen.getAllByTestId('cursor')).toHaveLength(5);
    fireEvent.mouseLeave(charts[0]);
    expect(screen.queryAllByTestId('cursor')).toHaveLength(0);
  });

  it('opens on click and toggles selection on shift-click', () => {
    const handlers = renderGrid();
    const chart = within(screen.getAllByRole('group')[1]).getByRole('img', { name: /^Series for job/ });
    fireEvent.click(chart);
    expect(handlers.onOpen).toHaveBeenCalledTimes(1);
    fireEvent.click(chart, { shiftKey: true });
    expect(handlers.onToggleSelect).toHaveBeenCalledTimes(1);
  });

  it('exposes baseline and dashboard actions', () => {
    const handlers = renderGrid();
    const cell = screen.getAllByRole('group')[0];
    fireEvent.click(within(cell).getByRole('button', { name: 'Set as baseline' }));
    expect(handlers.onSetBaseline).toHaveBeenCalledWith(expect.objectContaining({ key: 'a100-5' }));
    fireEvent.click(within(cell).getByRole('button', { name: 'Open job dashboard' }));
    expect(handlers.onOpenDashboard).toHaveBeenCalledWith(expect.objectContaining({ key: 'a100-5' }));
  });

  it('shows error and no-data cells and the running note on the progress axis', () => {
    renderGrid({ xAxis: 'progress' }, [makeJob(6), makeJob(7, 'RUNNING', 0)]);
    expect(within(screen.getByRole('group', { name: 'Job 6' })).getByText("Couldn't load this job's series.")).toBeInTheDocument();
    const running = screen.getByRole('group', { name: 'Job 7' });
    expect(within(running).getByText('No data for this metric')).toBeInTheDocument();
    expect(within(running).getByText('running: progress relative to now')).toBeInTheDocument();
  });
});
