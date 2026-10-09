import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { JobRecord } from '../../api/types';
import { CompareOverlay } from './CompareOverlay';
import { buildCompareView } from './compareView';
import { DEFAULT_VIEW_STATE } from './model';
import { JobSeries } from './seriesTransform';

function makeJob(jobId: number): JobRecord {
  return {
    clusterId: 'a100',
    jobId,
    name: `train-${jobId}`,
    user: 'alice',
    account: 'ml',
    partition: 'gpu',
    state: 'COMPLETED',
    nodes: ['n1'],
    nodeList: 'n1',
    nodeCount: 1,
    gpusTotal: 8,
    submitTime: 0,
    startTime: 1000,
    endTime: 4600,
    exitCode: 0,
    workDir: '/tmp',
    tres: '',
    templateId: 'overview',
  };
}

function flat(value: number): JobSeries {
  return { times: [1000, 2800, 4600], mean: [value, value, value], min: [value, value, value], max: [value, value, value] };
}

function renderOverlay(count: number, overrides: Partial<typeof DEFAULT_VIEW_STATE> = {}) {
  const jobs = Array.from({ length: count }, (_, i) => makeJob(i + 1));
  const state = { ...DEFAULT_VIEW_STATE, layout: 'overlay' as const, sort: 'job-id' as const, ...overrides };
  const model = buildCompareView({
    jobs,
    series: new Map(jobs.map((job) => [`a100-${job.jobId}`, flat(job.jobId)])),
    failedJobKeys: new Set(),
    loading: false,
    view: state,
    now: 10_000,
  });
  render(<CompareOverlay model={model} state={state} />);
}

describe('CompareOverlay', () => {
  it('draws one line and one legend row per job', () => {
    renderOverlay(3);
    expect(screen.getByRole('img', { name: 'Overlay of job series' })).toBeInTheDocument();
    expect(screen.getByTestId('legend-1')).toHaveTextContent('#1');
    expect(screen.getByTestId('line-a100-3')).toBeInTheDocument();
    expect(screen.queryByText(/Overlay shows up to/)).toBeNull();
  });

  it('dims other lines while a legend row is hovered', () => {
    renderOverlay(3);
    fireEvent.mouseEnter(screen.getByTestId('legend-2'));
    expect(screen.getByTestId('line-a100-1')).toHaveAttribute('stroke-opacity', '0.2');
    expect(screen.getByTestId('line-a100-2')).toHaveAttribute('stroke-opacity', '1');
    fireEvent.mouseLeave(screen.getByTestId('legend-2'));
    expect(screen.getByTestId('line-a100-1')).toHaveAttribute('stroke-opacity', '1');
  });

  it('warns when more than 10 jobs are available', () => {
    renderOverlay(12);
    expect(screen.getByText('Overlay shows up to 10 jobs')).toBeInTheDocument();
    expect(screen.getAllByTestId(/^legend-\d+$/)).toHaveLength(10);
  });

  it('draws the baseline as a separate thick line', () => {
    renderOverlay(3, { baselineJobId: '2' });
    expect(screen.getByTestId('line-baseline')).toHaveAttribute('stroke-width', '3');
    expect(screen.queryByTestId('line-a100-2')).toBeNull();
    expect(screen.getByTestId('legend-baseline')).toHaveTextContent('#2 (baseline)');
  });
});
