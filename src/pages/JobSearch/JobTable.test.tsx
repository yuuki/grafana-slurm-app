import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { JobRecord } from '../../api/types';
import { JobTable } from './JobTable';

const jobs: JobRecord[] = [
  {
    clusterId: 'a100',
    jobId: 10001,
    name: 'train',
    user: 'researcher1',
    account: 'ml-team',
    partition: 'gpu-a100',
    state: 'RUNNING',
    nodes: ['gpu-node001'],
    nodeList: 'gpu-node001',
    nodeCount: 1,
    gpusTotal: 8,
    startTime: 1700000000,
    endTime: 0,
    exitCode: 0,
    workDir: '/tmp',
    tres: 'gres/gpu=8',
    templateId: 'overview',
  },
];

describe('JobTable', () => {
  it('renders a load more button with loaded and total counts', () => {
    render(
      <JobTable
        jobs={jobs}
        loading={false}
        hasMore={true}
        loadingMore={false}
        loadedCount={300}
        totalCount={15000}
        pageSize={100}
        onLoadMore={jest.fn()}
        onOpenJob={jest.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Show 100 more (300/15000)' })).toBeInTheDocument();
  });

  it('uses the remaining count when fewer than page size jobs are left', () => {
    render(
      <JobTable
        jobs={jobs}
        loading={false}
        hasMore={true}
        loadingMore={false}
        loadedCount={14960}
        totalCount={15000}
        pageSize={100}
        onLoadMore={jest.fn()}
        onOpenJob={jest.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Show 40 more (14960/15000)' })).toBeInTheDocument();
  });

  it('disables the load more button while more jobs are loading', () => {
    render(
      <JobTable
        jobs={jobs}
        loading={false}
        hasMore={true}
        loadingMore={true}
        loadedCount={300}
        totalCount={15000}
        pageSize={100}
        onLoadMore={jest.fn()}
        onOpenJob={jest.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Show 100 more (300/15000)' })).toBeDisabled();
  });

  it('calls onLoadMore when the button is clicked', () => {
    const onLoadMore = jest.fn();

    render(
      <JobTable
        jobs={jobs}
        loading={false}
        hasMore={true}
        loadingMore={false}
        loadedCount={300}
        totalCount={15000}
        pageSize={100}
        onLoadMore={onLoadMore}
        onOpenJob={jest.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show 100 more (300/15000)' }));

    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('shows "..." for utilization columns when utilizationMap is provided but job key is absent', () => {
    render(
      <JobTable
        jobs={jobs}
        loading={false}
        hasMore={false}
        loadingMore={false}
        loadedCount={1}
        totalCount={1}
        pageSize={100}
        utilizationMap={new Map()}
        onLoadMore={jest.fn()}
        onOpenJob={jest.fn()}
      />
    );

    const cells = screen.getAllByText('...');
    // Both the Avg CPU% and Avg GPU% cells should show "..."
    expect(cells.length).toBeGreaterThanOrEqual(2);
  });

  it('shows utilization values when utilizationMap contains the job key', () => {
    const key = `${jobs[0].clusterId}-${jobs[0].jobId}`;
    const map = new Map([[key, { cpuPercent: 62.5, gpuPercent: 80.0 }]]);

    render(
      <JobTable
        jobs={jobs}
        loading={false}
        hasMore={false}
        loadingMore={false}
        loadedCount={1}
        totalCount={1}
        pageSize={100}
        utilizationMap={map}
        onLoadMore={jest.fn()}
        onOpenJob={jest.fn()}
      />
    );

    expect(screen.getByText('62.5%')).toBeInTheDocument();
    expect(screen.getByText('80.0%')).toBeInTheDocument();
  });

  it('shows "-" for GPU column when gpusTotal is 0', () => {
    const nonGpuJob = { ...jobs[0], gpusTotal: 0 };
    const key = `${nonGpuJob.clusterId}-${nonGpuJob.jobId}`;
    const map = new Map([[key, { cpuPercent: 50.0, gpuPercent: 90.0 }]]);

    render(
      <JobTable
        jobs={[nonGpuJob]}
        loading={false}
        hasMore={false}
        loadingMore={false}
        loadedCount={1}
        totalCount={1}
        pageSize={100}
        utilizationMap={map}
        onLoadMore={jest.fn()}
        onOpenJob={jest.fn()}
      />
    );

    expect(screen.getByText('50.0%')).toBeInTheDocument();
    // Avg GPU% is fixed to "-" because gpusTotal === 0
    const dashCells = screen.getAllByText('-');
    expect(dashCells.length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('90.0%')).not.toBeInTheDocument();
  });

  it('shows "-" for utilization when job key exists with undefined values (completed job)', () => {
    const key = `${jobs[0].clusterId}-${jobs[0].jobId}`;
    const map = new Map([[key, { cpuPercent: undefined, gpuPercent: undefined }]]);

    render(
      <JobTable
        jobs={jobs}
        loading={false}
        hasMore={false}
        loadingMore={false}
        loadedCount={1}
        totalCount={1}
        pageSize={100}
        utilizationMap={map}
        onLoadMore={jest.fn()}
        onOpenJob={jest.fn()}
      />
    );

    // Key exists so "..." is not shown; value is undefined so "-" is shown
    expect(screen.queryByText('...')).not.toBeInTheDocument();
    const dashCells = screen.getAllByText('-');
    expect(dashCells.length).toBeGreaterThanOrEqual(2);
  });

  it('shows "-" for utilization when utilizationMap is not provided', () => {
    render(
      <JobTable
        jobs={jobs}
        loading={false}
        hasMore={false}
        loadingMore={false}
        loadedCount={1}
        totalCount={1}
        pageSize={100}
        onLoadMore={jest.fn()}
        onOpenJob={jest.fn()}
      />
    );

    // No utilizationMap → "..." is never shown (formatPercent(undefined, false) = "-")
    expect(screen.queryByText('...')).not.toBeInTheDocument();
  });

  it('passes the full job record when a row is clicked', () => {
    const onOpenJob = jest.fn();

    render(
      <JobTable
        jobs={jobs}
        loading={false}
        hasMore={false}
        loadingMore={false}
        loadedCount={1}
        totalCount={1}
        pageSize={100}
        onLoadMore={jest.fn()}
        onOpenJob={onOpenJob}
      />
    );

    fireEvent.click(screen.getByText('train'));

    expect(onOpenJob).toHaveBeenCalledWith(jobs[0]);
  });
});
