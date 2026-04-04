import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { listClusters, listJobMetadataOptions, listJobs, listLinkableDashboards } from '../../api/slurmApi';
import { loadLinkedDashboardSelection, saveLinkedDashboardSelection } from '../../storage/userPreferences';
import { navigateToJobPage, navigateToLinkedDashboard } from './navigation';
import { JobSearchPage } from './JobSearchPage';

jest.mock('../../api/slurmApi', () => ({
  listClusters: jest.fn(),
  listJobs: jest.fn(),
  listJobMetadataOptions: jest.fn(),
  listLinkableDashboards: jest.fn(),
}));

jest.mock('./jobMetrics', () => ({
  fetchJobsUtilizationBatch: jest.fn().mockResolvedValue(new Map()),
}));

jest.mock('../../storage/userPreferences', () => ({
  loadSearchPreferences: jest.fn(() => ({})),
  saveSearchPreferences: jest.fn(),
  loadTimelineTimeRange: jest.fn(() => null),
  saveTimelineTimeRange: jest.fn(),
  loadLinkedDashboardSelection: jest.fn(() => null),
  saveLinkedDashboardSelection: jest.fn(),
}));

jest.mock('./navigation', () => ({
  navigateToJobPage: jest.fn(),
  navigateToLinkedDashboard: jest.fn(),
}));

const mockedListClusters = listClusters as jest.MockedFunction<typeof listClusters>;
const mockedListJobs = listJobs as jest.MockedFunction<typeof listJobs>;
const mockedListJobMetadataOptions = listJobMetadataOptions as jest.MockedFunction<typeof listJobMetadataOptions>;
const mockedListLinkableDashboards = listLinkableDashboards as jest.MockedFunction<typeof listLinkableDashboards>;
const mockedLoadLinkedDashboardSelection = loadLinkedDashboardSelection as jest.MockedFunction<
  typeof loadLinkedDashboardSelection
>;
const mockedSaveLinkedDashboardSelection = saveLinkedDashboardSelection as jest.MockedFunction<
  typeof saveLinkedDashboardSelection
>;
const mockedNavigateToJobPage = navigateToJobPage as jest.MockedFunction<typeof navigateToJobPage>;
const mockedNavigateToLinkedDashboard = navigateToLinkedDashboard as jest.MockedFunction<typeof navigateToLinkedDashboard>;

describe('JobSearchPage', () => {
  beforeEach(() => {
    mockedListClusters.mockReset();
    mockedListJobs.mockReset();
    mockedListJobMetadataOptions.mockReset();
    mockedListLinkableDashboards.mockReset();
    mockedLoadLinkedDashboardSelection.mockReset();
    mockedLoadLinkedDashboardSelection.mockReturnValue(null);
    mockedSaveLinkedDashboardSelection.mockReset();
    mockedNavigateToJobPage.mockReset();
    mockedNavigateToLinkedDashboard.mockReset();
  });

  it('re-runs job search immediately when a metadata suggestion is selected', async () => {
    mockedListClusters.mockResolvedValue({
      clusters: [
        {
          id: 'a100',
          displayName: 'A100',
          slurmClusterName: 'gpu_cluster',
          metricsDatasourceUid: 'prom',
          metricsType: 'prometheus',
          aggregationNodeLabels: ['host.name', 'instance'],
          instanceLabel: 'instance',
          nodeMatcherMode: 'hostname',
          defaultTemplateId: 'overview',
          metricsFilterLabel: '',
          metricsFilterValue: '',
        },
      ],
    });
    mockedListJobs
      .mockResolvedValueOnce({ jobs: [], total: 0 })
      .mockResolvedValueOnce({
        jobs: [
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
        ],
        total: 1,
      });
    mockedListJobMetadataOptions.mockResolvedValue({ values: ['researcher1'] });

    render(<JobSearchPage />);

    await waitFor(() => {
      expect(mockedListJobs).toHaveBeenCalledWith({ clusterId: 'a100', limit: 100 });
    });

    const input = screen.getByPlaceholderText('Username');
    fireEvent.focus(input);
    await screen.findByRole('option', { name: 'researcher1' });
    fireEvent.mouseDown(screen.getByRole('option', { name: 'researcher1' }));

    await waitFor(() => {
      expect(mockedListJobs).toHaveBeenCalledTimes(2);
      expect(mockedListJobs).toHaveBeenLastCalledWith(
        expect.objectContaining({
          clusterId: 'a100',
          user: 'researcher1',
          limit: 100,
        })
      );
    });
  });

  it('renders the timeline above the table for returned jobs', async () => {
    mockedListClusters.mockResolvedValue({
      clusters: [
        {
          id: 'a100',
          displayName: 'A100',
          slurmClusterName: 'gpu_cluster',
          metricsDatasourceUid: 'prom',
          metricsType: 'prometheus',
          aggregationNodeLabels: ['host.name', 'instance'],
          instanceLabel: 'instance',
          nodeMatcherMode: 'hostname',
          defaultTemplateId: 'overview',
          metricsFilterLabel: '',
          metricsFilterValue: '',
        },
      ],
    });
    mockedListJobs.mockResolvedValue({
      jobs: [
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
      ],
      total: 1,
    });

    render(<JobSearchPage />);

    expect(await screen.findByRole('heading', { name: 'Job Timeline' })).toBeInTheDocument();
    expect(screen.getByTestId('job-timeline-bar-10001')).toBeInTheDocument();
    expect(screen.getByText('gpu-a100 / researcher1 / 1 node')).toBeInTheDocument();
  });

  it('appends jobs and updates the load more label and timeline', async () => {
    mockedListClusters.mockResolvedValue({
      clusters: [
        {
          id: 'a100',
          displayName: 'A100',
          slurmClusterName: 'gpu_cluster',
          metricsDatasourceUid: 'prom',
          metricsType: 'prometheus',
          aggregationNodeLabels: ['host.name', 'instance'],
          instanceLabel: 'instance',
          nodeMatcherMode: 'hostname',
          defaultTemplateId: 'overview',
          metricsFilterLabel: '',
          metricsFilterValue: '',
        },
      ],
    });
    mockedListJobs
      .mockResolvedValueOnce({
        jobs: Array.from({ length: 100 }, (_, index) => ({
          clusterId: 'a100',
          jobId: 10001 + index,
          name: `train-${index + 1}`,
          user: 'researcher1',
          account: 'ml-team',
          partition: 'gpu-a100',
          state: 'RUNNING',
          nodes: [`gpu-node${String(index + 1).padStart(3, '0')}`],
          nodeList: `gpu-node${String(index + 1).padStart(3, '0')}`,
          nodeCount: 1,
          gpusTotal: 8,
          startTime: 1700000000 + index,
          endTime: 0,
          exitCode: 0,
          workDir: '/tmp',
          tres: 'gres/gpu=8',
          templateId: 'overview',
        })),
        nextCursor: 'MTAw',
        total: 250,
      })
      .mockResolvedValueOnce({
        jobs: Array.from({ length: 100 }, (_, index) => ({
          clusterId: 'a100',
          jobId: 10101 + index,
          name: `train-${index + 101}`,
          user: 'researcher1',
          account: 'ml-team',
          partition: 'gpu-a100',
          state: 'RUNNING',
          nodes: [`gpu-node${String(index + 101).padStart(3, '0')}`],
          nodeList: `gpu-node${String(index + 101).padStart(3, '0')}`,
          nodeCount: 1,
          gpusTotal: 8,
          startTime: 1700000100 + index,
          endTime: 0,
          exitCode: 0,
          workDir: '/tmp',
          tres: 'gres/gpu=8',
          templateId: 'overview',
        })),
        nextCursor: 'MjAw',
        total: 250,
      });

    render(<JobSearchPage />);

    expect(await screen.findByRole('button', { name: 'Show 100 more (100/250)' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show 100 more (100/250)' }));

    await waitFor(() => {
      expect(mockedListJobs).toHaveBeenLastCalledWith({ clusterId: 'a100', limit: 100, cursor: 'MTAw' });
    });

    expect(await screen.findByRole('button', { name: 'Show 50 more (200/250)' })).toBeInTheDocument();
    expect(screen.getAllByText('10200')).toHaveLength(2);
    expect(screen.getByTestId('job-timeline-bar-10200')).toBeInTheDocument();
  });

  it('keeps the loaded rows visible when loading more jobs fails', async () => {
    mockedListClusters.mockResolvedValue({
      clusters: [
        {
          id: 'a100',
          displayName: 'A100',
          slurmClusterName: 'gpu_cluster',
          metricsDatasourceUid: 'prom',
          metricsType: 'prometheus',
          aggregationNodeLabels: ['host.name', 'instance'],
          instanceLabel: 'instance',
          nodeMatcherMode: 'hostname',
          defaultTemplateId: 'overview',
          metricsFilterLabel: '',
          metricsFilterValue: '',
        },
      ],
    });
    mockedListJobs
      .mockResolvedValueOnce({
        jobs: [
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
        ],
        nextCursor: 'MQ==',
        total: 2,
      })
      .mockRejectedValueOnce(new Error('load more failed'));

    render(<JobSearchPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Show 1 more (1/2)' }));

    expect(await screen.findByText('load more failed')).toBeInTheDocument();
    expect(screen.getAllByText('10001')).toHaveLength(2);
  });

  it('opens a dashboard picker and navigates to the selected linked dashboard on row click', async () => {
    mockedListClusters.mockResolvedValue({
      clusters: [
        {
          id: 'a100',
          displayName: 'A100',
          slurmClusterName: 'gpu_cluster',
          metricsDatasourceUid: 'prom',
          metricsType: 'prometheus',
          instanceLabel: 'instance',
          nodeMatcherMode: 'hostname',
          defaultTemplateId: 'overview',
          metricsFilterLabel: '',
          metricsFilterValue: '',
        },
      ],
    });
    mockedListJobs.mockResolvedValue({
      jobs: [
        {
          clusterId: 'a100',
          jobId: 10001,
          name: 'train',
          user: 'researcher1',
          account: 'ml-team',
          partition: 'gpu-a100',
          state: 'RUNNING',
          nodes: ['gpu-node001', 'gpu-node002'],
          nodeList: 'gpu-node[001-002]',
          nodeCount: 2,
          gpusTotal: 8,
          startTime: 1700000000,
          endTime: 1700003600,
          exitCode: 0,
          workDir: '/tmp',
          tres: 'gres/gpu=8',
          templateId: 'overview',
        },
      ],
      total: 1,
    });
    mockedListLinkableDashboards.mockResolvedValue([
      {
        uid: 'linked-job-dashboard',
        title: 'Linked Job Dashboard',
        url: '/d/linked-job-dashboard/linked-job-dashboard',
        tags: ['slurm-job-link'],
      },
    ]);

    render(<JobSearchPage />);

    fireEvent.click(await screen.findByRole('row', { name: /10001\s+train\s+researcher1/i }));

    expect(await screen.findByRole('dialog', { name: 'Open linked dashboard' })).toBeInTheDocument();
    expect(mockedListLinkableDashboards).toHaveBeenCalledWith('slurm-job-link');

    fireEvent.click(screen.getByLabelText('Linked Job Dashboard'));
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    expect(mockedSaveLinkedDashboardSelection).toHaveBeenCalledWith('a100', 'dashboard:linked-job-dashboard');
    expect(mockedNavigateToLinkedDashboard).toHaveBeenCalledWith(expect.stringContaining('var-slurm_job_id=10001'));
  });

  it('shows job view as the default destination when no selection is saved', async () => {
    mockedListClusters.mockResolvedValue({
      clusters: [
        {
          id: 'a100',
          displayName: 'A100',
          slurmClusterName: 'gpu_cluster',
          metricsDatasourceUid: 'prom',
          metricsType: 'prometheus',
          instanceLabel: 'instance',
          nodeMatcherMode: 'hostname',
          defaultTemplateId: 'overview',
          metricsFilterLabel: '',
          metricsFilterValue: '',
        },
      ],
    });
    mockedListJobs.mockResolvedValue({
      jobs: [
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
          endTime: 1700003600,
          exitCode: 0,
          workDir: '/tmp',
          tres: 'gres/gpu=8',
          templateId: 'overview',
        },
      ],
      total: 1,
    });
    mockedListLinkableDashboards.mockResolvedValue([
      {
        uid: 'linked-job-dashboard',
        title: 'Linked Job Dashboard',
        url: '/d/linked-job-dashboard/linked-job-dashboard',
        tags: ['slurm-job-link'],
      },
    ]);

    render(<JobSearchPage />);

    fireEvent.click(await screen.findByRole('row', { name: /10001\s+train\s+researcher1/i }));

    expect(await screen.findByRole('dialog', { name: 'Open linked dashboard' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText('Job view')).toBeChecked();
    });
  });

  it('navigates to the job page from the picker and stores job view selection', async () => {
    mockedListClusters.mockResolvedValue({
      clusters: [
        {
          id: 'a100',
          displayName: 'A100',
          slurmClusterName: 'gpu_cluster',
          metricsDatasourceUid: 'prom',
          metricsType: 'prometheus',
          instanceLabel: 'instance',
          nodeMatcherMode: 'hostname',
          defaultTemplateId: 'overview',
          metricsFilterLabel: '',
          metricsFilterValue: '',
        },
      ],
    });
    mockedListJobs.mockResolvedValue({
      jobs: [
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
          endTime: 1700003600,
          exitCode: 0,
          workDir: '/tmp',
          tres: 'gres/gpu=8',
          templateId: 'overview',
        },
      ],
      total: 1,
    });
    mockedListLinkableDashboards.mockResolvedValue([
      {
        uid: 'linked-job-dashboard',
        title: 'Linked Job Dashboard',
        url: '/d/linked-job-dashboard/linked-job-dashboard',
        tags: ['slurm-job-link'],
      },
    ]);

    render(<JobSearchPage />);

    fireEvent.click(await screen.findByRole('row', { name: /10001\s+train\s+researcher1/i }));

    expect(await screen.findByRole('dialog', { name: 'Open linked dashboard' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    expect(mockedSaveLinkedDashboardSelection).toHaveBeenCalledWith('a100', 'job-view');
    expect(mockedNavigateToJobPage).toHaveBeenCalledWith('a100', 10001);
    expect(mockedNavigateToLinkedDashboard).not.toHaveBeenCalled();
  });

  it('uses the saved linked dashboard selection when the picker opens', async () => {
    mockedLoadLinkedDashboardSelection.mockReturnValue('dashboard:preferred-dashboard');
    mockedListClusters.mockResolvedValue({
      clusters: [
        {
          id: 'a100',
          displayName: 'A100',
          slurmClusterName: 'gpu_cluster',
          metricsDatasourceUid: 'prom',
          metricsType: 'prometheus',
          instanceLabel: 'instance',
          nodeMatcherMode: 'hostname',
          defaultTemplateId: 'overview',
          metricsFilterLabel: '',
          metricsFilterValue: '',
        },
      ],
    });
    mockedListJobs.mockResolvedValue({
      jobs: [
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
          endTime: 1700003600,
          exitCode: 0,
          workDir: '/tmp',
          tres: 'gres/gpu=8',
          templateId: 'overview',
        },
      ],
      total: 1,
    });
    mockedListLinkableDashboards.mockResolvedValue([
      {
        uid: 'other-dashboard',
        title: 'Other Dashboard',
        url: '/d/other-dashboard',
        tags: ['slurm-job-link'],
      },
      {
        uid: 'preferred-dashboard',
        title: 'Preferred Dashboard',
        url: '/d/preferred-dashboard',
        tags: ['slurm-job-link'],
      },
    ]);

    render(<JobSearchPage />);

    fireEvent.click(await screen.findByRole('row', { name: /10001\s+train\s+researcher1/i }));

    expect(await screen.findByRole('dialog', { name: 'Open linked dashboard' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText('Preferred Dashboard')).toBeChecked();
    });
  });

  it('uses the saved job view selection when the picker opens', async () => {
    mockedLoadLinkedDashboardSelection.mockReturnValue('job-view');
    mockedListClusters.mockResolvedValue({
      clusters: [
        {
          id: 'a100',
          displayName: 'A100',
          slurmClusterName: 'gpu_cluster',
          metricsDatasourceUid: 'prom',
          metricsType: 'prometheus',
          instanceLabel: 'instance',
          nodeMatcherMode: 'hostname',
          defaultTemplateId: 'overview',
          metricsFilterLabel: '',
          metricsFilterValue: '',
        },
      ],
    });
    mockedListJobs.mockResolvedValue({
      jobs: [
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
          endTime: 1700003600,
          exitCode: 0,
          workDir: '/tmp',
          tres: 'gres/gpu=8',
          templateId: 'overview',
        },
      ],
      total: 1,
    });
    mockedListLinkableDashboards.mockResolvedValue([
      {
        uid: 'linked-job-dashboard',
        title: 'Linked Job Dashboard',
        url: '/d/linked-job-dashboard',
        tags: ['slurm-job-link'],
      },
    ]);

    render(<JobSearchPage />);

    fireEvent.click(await screen.findByRole('row', { name: /10001\s+train\s+researcher1/i }));

    expect(await screen.findByRole('dialog', { name: 'Open linked dashboard' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText('Job view')).toBeChecked();
    });
  });

  it('navigates to the job page from the table when no linked dashboards are found', async () => {
    mockedListClusters.mockResolvedValue({
      clusters: [
        {
          id: 'a100',
          displayName: 'A100',
          slurmClusterName: 'gpu_cluster',
          metricsDatasourceUid: 'prom',
          metricsType: 'prometheus',
          instanceLabel: 'instance',
          nodeMatcherMode: 'hostname',
          defaultTemplateId: 'overview',
          metricsFilterLabel: '',
          metricsFilterValue: '',
        },
      ],
    });
    mockedListJobs.mockResolvedValue({
      jobs: [
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
          endTime: 1700003600,
          exitCode: 0,
          workDir: '/tmp',
          tres: 'gres/gpu=8',
          templateId: 'overview',
        },
      ],
      total: 1,
    });
    mockedListLinkableDashboards.mockResolvedValue([]);

    render(<JobSearchPage />);

    fireEvent.click(await screen.findByRole('row', { name: /10001\s+train\s+researcher1/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Open linked dashboard' })).not.toBeInTheDocument();
    });
    expect(mockedNavigateToJobPage).toHaveBeenCalledWith('a100', 10001);
  });

  it('navigates to the job page from the timeline when no linked dashboards are found', async () => {
    mockedListClusters.mockResolvedValue({
      clusters: [
        {
          id: 'a100',
          displayName: 'A100',
          slurmClusterName: 'gpu_cluster',
          metricsDatasourceUid: 'prom',
          metricsType: 'prometheus',
          aggregationNodeLabels: ['host.name', 'instance'],
          instanceLabel: 'instance',
          nodeMatcherMode: 'hostname',
          defaultTemplateId: 'overview',
          metricsFilterLabel: '',
          metricsFilterValue: '',
        },
      ],
    });
    mockedListJobs.mockResolvedValue({
      jobs: [
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
          endTime: 1700003600,
          exitCode: 0,
          workDir: '/tmp',
          tres: 'gres/gpu=8',
          templateId: 'overview',
        },
      ],
      total: 1,
    });
    mockedListLinkableDashboards.mockResolvedValue([]);

    render(<JobSearchPage />);

    fireEvent.click(await screen.findByTestId('job-timeline-bar-10001'));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Open linked dashboard' })).not.toBeInTheDocument();
    });
    expect(mockedNavigateToJobPage).toHaveBeenCalledWith('a100', 10001);
  });
});
