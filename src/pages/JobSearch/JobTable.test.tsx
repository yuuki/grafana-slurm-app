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
});
