import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { getJob, listClusters, listJobs } from '../../api/slurmApi';
import { JobRecord } from '../../api/types';
import { fetchMetricTypes, listMetricNames } from './metricCatalog';
import { fetchCompareSeries } from './metricQuery';
import { JobComparePage } from './JobComparePage';

jest.mock('../../api/slurmApi', () => ({
  listClusters: jest.fn(),
  listJobs: jest.fn(),
  getJob: jest.fn(),
  listJobMetadataOptions: jest.fn().mockResolvedValue({ values: [] }),
}));

jest.mock('./metricCatalog', () => ({
  ...jest.requireActual('./metricCatalog'),
  listMetricNames: jest.fn(),
  fetchMetricTypes: jest.fn(),
}));

jest.mock('./metricQuery', () => ({
  ...jest.requireActual('./metricQuery'),
  fetchCompareSeries: jest.fn(),
}));

jest.mock('../../storage/userPreferences', () => ({
  loadCompareViewPreferences: jest.fn(() => ({})),
  saveCompareViewPreferences: jest.fn(),
}));

jest.mock('../JobSearch/navigation', () => ({
  navigateToJobPage: jest.fn(),
}));

jest.mock('./JobDetailModal', () => ({
  JobDetailModal: () => <div data-testid="job-detail-modal" />,
}));

jest.mock('@grafana/ui', () => {
  const actual = jest.requireActual('@grafana/ui');
  return { ...actual, TimeRangeInput: () => <div data-testid="time-range-input" /> };
});

const mockedListClusters = listClusters as jest.MockedFunction<typeof listClusters>;
const mockedListJobs = listJobs as jest.MockedFunction<typeof listJobs>;
const mockedGetJob = getJob as jest.MockedFunction<typeof getJob>;
const mockedListMetricNames = listMetricNames as jest.MockedFunction<typeof listMetricNames>;
const mockedFetchMetricTypes = fetchMetricTypes as jest.MockedFunction<typeof fetchMetricTypes>;
const mockedFetchCompareSeries = fetchCompareSeries as jest.MockedFunction<typeof fetchCompareSeries>;

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

function makeJob(jobId: number): JobRecord {
  return {
    clusterId: 'a100',
    jobId,
    name: `train-${jobId}`,
    user: 'alice',
    account: 'ml',
    partition: 'gpu',
    state: 'COMPLETED',
    nodes: [`n${jobId}`],
    nodeList: `n${jobId}`,
    nodeCount: 1,
    gpusTotal: 8,
    submitTime: 1000,
    startTime: 1000,
    endTime: 4600,
    exitCode: 0,
    workDir: '/tmp',
    tres: '',
    templateId: 'overview',
  };
}

function seriesFor(jobIds: number[]) {
  return new Map(
    jobIds.map((id) => [`a100-${id}`, { times: [1000, 2800, 4600], mean: [id, id, id], min: [id, id, id], max: [id, id, id] }])
  );
}

function setURL(query: string) {
  window.history.replaceState(null, '', `/a/yuuki-slurm-app/compare${query}`);
}

describe('JobComparePage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedListClusters.mockResolvedValue({ clusters: [cluster] });
    mockedListMetricNames.mockResolvedValue(['DCGM_FI_DEV_GPU_UTIL', 'node_load1']);
    mockedFetchMetricTypes.mockResolvedValue(new Map([['DCGM_FI_DEV_GPU_UTIL', 'gauge']]));
    mockedListJobs.mockResolvedValue({ jobs: [makeJob(1), makeJob(2)], total: 2 });
    mockedFetchCompareSeries.mockResolvedValue({ series: seriesFor([1, 2]), failedJobKeys: new Set() });
  });

  it('asks for a metric before querying series', async () => {
    setURL('?cluster=a100');
    render(<JobComparePage />);
    expect(await screen.findByText('Pick a metric to compare')).toBeInTheDocument();
    expect(mockedFetchCompareSeries).not.toHaveBeenCalled();
  });

  it('loads up to 48 filtered jobs and renders one cell per job', async () => {
    setURL('?cluster=a100&user=alice&metric=DCGM_FI_DEV_GPU_UTIL');
    render(<JobComparePage />);
    expect(await screen.findByRole('group', { name: 'Job 1' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Job 2' })).toBeInTheDocument();
    expect(mockedListJobs).toHaveBeenCalledWith(expect.objectContaining({ clusterId: 'a100', user: 'alice', limit: 48 }));
    expect(mockedFetchCompareSeries).toHaveBeenCalledWith(
      expect.objectContaining({ metricName: 'DCGM_FI_DEV_GPU_UTIL', metricType: 'gauge' })
    );
    await waitFor(() => expect(window.location.search).toContain('metric=DCGM_FI_DEV_GPU_UTIL'));
  });

  it('loads picked jobs by id in pick mode', async () => {
    mockedGetJob.mockImplementation(async (_cluster, id) => makeJob(Number(id)));
    setURL('?cluster=a100&mode=pick&jobs=1,2&metric=node_load1');
    render(<JobComparePage />);
    expect(await screen.findByRole('group', { name: 'Job 2' })).toBeInTheDocument();
    expect(mockedGetJob).toHaveBeenCalledTimes(2);
    expect(mockedListJobs).not.toHaveBeenCalled();
    expect(screen.getByText('2 picked jobs')).toBeInTheDocument();
  });

  it('reports failed jobs and retries', async () => {
    mockedFetchCompareSeries.mockResolvedValueOnce({ series: seriesFor([1]), failedJobKeys: new Set(['a100-2']) });
    setURL('?cluster=a100&metric=node_load1');
    render(<JobComparePage />);
    expect(await screen.findByText('1 of 2 jobs failed to load')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(mockedFetchCompareSeries).toHaveBeenCalledTimes(2));
  });

  it('switches to overlay layout', async () => {
    setURL('?cluster=a100&metric=node_load1');
    render(<JobComparePage />);
    await screen.findByRole('group', { name: 'Job 1' });
    fireEvent.click(screen.getByRole('radio', { name: 'Overlay' }));
    expect(await screen.findByRole('img', { name: 'Overlay of job series' })).toBeInTheDocument();
  });

  it('opens the detail modal from a cell', async () => {
    setURL('?cluster=a100&metric=node_load1');
    render(<JobComparePage />);
    const cell = await screen.findByRole('group', { name: 'Job 1' });
    fireEvent.click(cell.querySelector('svg[role="img"]')!);
    expect(screen.getByTestId('job-detail-modal')).toBeInTheDocument();
  });

  it('explains a missing metrics datasource', async () => {
    mockedListClusters.mockResolvedValue({ clusters: [{ ...cluster, metricsDatasourceUid: '' }] });
    setURL('?cluster=a100&metric=node_load1');
    render(<JobComparePage />);
    expect(await screen.findByText('This cluster has no metrics datasource')).toBeInTheDocument();
  });
});
