import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { JobRecord } from '../../api/types';
import { makeRelativeTimeRange } from '../JobSearch/timelineRange';
import { describeFilters, JobSetBar } from './JobSetBar';

jest.mock('../../api/slurmApi', () => ({
  listJobMetadataOptions: jest.fn().mockResolvedValue({ values: [] }),
}));

jest.mock('../JobSearch/navigation', () => ({
  navigateToJobPage: jest.fn(),
}));

jest.mock('@grafana/ui', () => {
  const actual = jest.requireActual('@grafana/ui');
  return {
    ...actual,
    TimeRangeInput: () => <div data-testid="time-range-input" />,
  };
});

const cluster = {
  id: 'a100',
  displayName: 'A100',
  slurmClusterName: 'slurm-a100',
  metricsDatasourceUid: 'prom',
  metricsType: 'prometheus' as const,
  aggregationNodeLabels: ['instance'],
  instanceLabel: 'instance',
  nodeMatcherMode: 'hostname' as const,
  defaultTemplateId: 'overview',
  metricsFilterLabel: '',
  metricsFilterValue: '',
};

const baseline = { jobId: 10231, name: 'llm-pretrain' } as JobRecord;

function renderBar(overrides: Partial<React.ComponentProps<typeof JobSetBar>> = {}) {
  const props: React.ComponentProps<typeof JobSetBar> = {
    clusters: [cluster],
    loadingClusters: false,
    mode: 'filter',
    filters: { clusterId: 'a100', user: 'alice' },
    appliedFilters: { clusterId: 'a100', user: 'alice' },
    timeRange: makeRelativeTimeRange('now-7d', 'now'),
    loading: false,
    error: null,
    shownCount: 12,
    total: 12,
    hiddenNonGpu: 0,
    missingIds: [],
    baseline: null,
    onFiltersChange: jest.fn(),
    onApplyFilter: jest.fn(),
    onTimeRangeChange: jest.fn(),
    onSwitchToFilter: jest.fn(),
    onClearBaseline: jest.fn(),
    ...overrides,
  };
  render(<JobSetBar {...props} />);
  return props;
}

describe('describeFilters', () => {
  it('summarizes the active filters', () => {
    expect(
      describeFilters({ clusterId: 'a100', user: 'alice', partition: 'gpu', nodesMin: '2', elapsedMin: '3600', jobId: '9' })
    ).toEqual(['user=alice', 'partition=gpu', 'nodes>=2', 'elapsed>=1h 0m']);
    expect(describeFilters({ clusterId: 'a100' })).toEqual([]);
  });
});

describe('JobSetBar', () => {
  it('summarizes the applied filter, time range, and count', () => {
    renderBar();
    expect(screen.getByText('A100')).toBeInTheDocument();
    expect(screen.getByText('user=alice')).toBeInTheDocument();
    expect(screen.getByText('now-7d to now')).toBeInTheDocument();
    expect(screen.getByText('12 jobs')).toBeInTheDocument();
  });

  it('explains the 48-job cap, hidden jobs, and missing jobs', () => {
    renderBar({ shownCount: 45, total: 213, hiddenNonGpu: 3, missingIds: ['7', '8'] });
    expect(screen.getByText('Showing 48 of 213 jobs. Narrow the filter to compare others.')).toBeInTheDocument();
    expect(screen.getByText('3 jobs hidden (no GPUs)')).toBeInTheDocument();
    expect(screen.getByText("Couldn't load jobs: 7, 8")).toBeInTheDocument();
  });

  it('opens the filter editor and applies it on search', () => {
    const props = renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Edit filter' }));
    expect(screen.getByTestId('time-range-input')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(props.onApplyFilter).toHaveBeenCalled();
  });

  it('describes pick mode and offers switching back to the filter', () => {
    const props = renderBar({ mode: 'pick', shownCount: 2, total: 2 });
    expect(screen.getByText('2 picked jobs')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit filter' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Use search filter' }));
    expect(props.onSwitchToFilter).toHaveBeenCalled();
  });

  it('shows and clears the baseline', () => {
    const props = renderBar({ baseline });
    expect(screen.getByText('Baseline: #10231 llm-pretrain')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear baseline' }));
    expect(props.onClearBaseline).toHaveBeenCalled();
  });

  it('shows the job loading error', () => {
    renderBar({ error: 'boom' });
    expect(screen.getByText('boom')).toBeInTheDocument();
  });
});
