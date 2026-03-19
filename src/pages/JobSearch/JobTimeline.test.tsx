import React from 'react';
import { fireEvent, render, screen, act } from '@testing-library/react';
import { dateTime, TimeRange } from '@grafana/data';
import { JobRecord } from '../../api/types';
import { JobTimeline } from './JobTimeline';

let capturedOnChange: ((range: TimeRange) => void) | undefined;

jest.mock('@grafana/ui', () => {
  const actual = jest.requireActual('@grafana/ui');
  return {
    ...actual,
    TimeRangePicker: (props: { value: TimeRange; onChange: (range: TimeRange) => void }) => {
      capturedOnChange = props.onChange;
      const rawFrom = props.value.raw.from;
      const rawTo = props.value.raw.to;
      const fromStr = typeof rawFrom === 'string' ? rawFrom : rawFrom.format('YYYY-MM-DD HH:mm');
      const toStr = typeof rawTo === 'string' ? rawTo : rawTo.format('YYYY-MM-DD HH:mm');
      return <div data-testid="time-range-picker">{`${fromStr} to ${toStr}`}</div>;
    },
  };
});

const BASE_START_TIME = 1700000000;
const RUNNING_NOW_TIME = 1700004200;
const MID_JOB_START_TIME = BASE_START_TIME + 600;
const MID_JOB_END_TIME = BASE_START_TIME + 2400;
const NARROW_JOB_START_TIME = BASE_START_TIME + 3300;
const NARROW_JOB_END_TIME = BASE_START_TIME + 3600;

describe('JobTimeline', () => {
  const jobs: JobRecord[] = [
    {
      clusterId: 'a100',
      jobId: 10001,
      name: 'train-wide',
      user: 'alice',
      account: 'ml',
      partition: 'gpu-a100',
      state: 'RUNNING',
      nodes: ['node001', 'node002', 'node003', 'node004'],
      nodeCount: 4,
      gpusTotal: 8,
      startTime: BASE_START_TIME,
      endTime: 0,
      exitCode: 0,
      workDir: '/tmp',
      tres: 'gres/gpu=8',
      templateId: 'overview',
    },
    {
      clusterId: 'a100',
      jobId: 10002,
      name: 'train-mid',
      user: 'bob',
      account: 'ml',
      partition: 'gpu-h100',
      state: 'COMPLETED',
      nodes: ['node010', 'node011'],
      nodeCount: 2,
      gpusTotal: 8,
      startTime: MID_JOB_START_TIME,
      endTime: MID_JOB_END_TIME,
      exitCode: 0,
      workDir: '/tmp',
      tres: 'gres/gpu=8',
      templateId: 'overview',
    },
    {
      clusterId: 'a100',
      jobId: 10003,
      name: 'train-narrow',
      user: 'carol',
      account: 'ml',
      partition: 'gpu-l40',
      state: 'FAILED',
      nodes: ['node020'],
      nodeCount: 1,
      gpusTotal: 1,
      startTime: NARROW_JOB_START_TIME,
      endTime: NARROW_JOB_END_TIME,
      exitCode: 1,
      workDir: '/tmp',
      tres: 'gres/gpu=1',
      templateId: 'overview',
    },
    {
      clusterId: 'a100',
      jobId: 10004,
      name: 'pending-no-start',
      user: 'dave',
      account: 'ml',
      partition: 'gpu-a100',
      state: 'PENDING',
      nodes: [],
      nodeCount: 0,
      gpusTotal: 0,
      startTime: 0,
      endTime: 0,
      exitCode: 0,
      workDir: '/tmp',
      tres: '',
      templateId: 'overview',
    },
  ];

  beforeEach(() => {
    capturedOnChange = undefined;
    jest.useFakeTimers();
    jest.setSystemTime(new Date(RUNNING_NOW_TIME * 1000));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders bars only for jobs with a start time and extends running jobs to now', () => {
    render(<JobTimeline jobs={jobs} loading={false} onOpenJob={jest.fn()} />);

    expect(screen.getAllByTestId('job-timeline-bar')).toHaveLength(3);
    expect(screen.queryByText('pending-no-start')).not.toBeInTheDocument();
    expect(screen.getByTestId('job-timeline-bar-10001').getAttribute('title')).toContain('End: In progress');
  });

  it('shows state color, hover details, and opens the job when a bar is clicked', () => {
    const onOpenJob = jest.fn();

    render(<JobTimeline jobs={jobs} loading={false} onOpenJob={onOpenJob} />);

    const runningBar = screen.getByTestId('job-timeline-bar-10001');
    expect(runningBar).toHaveStyle({ background: '#56A64B' });
    expect(runningBar.getAttribute('title')).toContain('Partition: gpu-a100');
    expect(runningBar.getAttribute('title')).toContain('User: alice');
    expect(runningBar.getAttribute('title')).toContain('Nodes: 4');

    fireEvent.click(runningBar);

    expect(onOpenJob).toHaveBeenCalledWith(jobs[0]);
  });

  it('shows a loading placeholder and an empty message', () => {
    const { rerender } = render(<JobTimeline jobs={[]} loading={true} onOpenJob={jest.fn()} />);

    expect(screen.getByText('Loading job timeline...')).toBeInTheDocument();

    rerender(<JobTimeline jobs={[]} loading={false} onOpenJob={jest.fn()} />);

    expect(screen.getByText('No chartable jobs found.')).toBeInTheDocument();
  });

  it('renders the time range picker with default relative range', () => {
    render(<JobTimeline jobs={jobs} loading={false} onOpenJob={jest.fn()} />);

    const picker = screen.getByTestId('time-range-picker');
    expect(picker).toBeInTheDocument();
    expect(picker.textContent).toBe('now-24h to now');
  });

  it('updates the timeline when time range is changed via the picker', () => {
    render(<JobTimeline jobs={jobs} loading={false} onOpenJob={jest.fn()} />);

    expect(capturedOnChange).toBeDefined();

    const fromDt = dateTime((BASE_START_TIME - 100) * 1000);
    const toDt = dateTime((NARROW_JOB_END_TIME + 100) * 1000);
    act(() => {
      capturedOnChange!({ from: fromDt, to: toDt, raw: { from: fromDt, to: toDt } });
    });

    expect(screen.getAllByTestId('job-timeline-bar')).toHaveLength(3);
  });
});
