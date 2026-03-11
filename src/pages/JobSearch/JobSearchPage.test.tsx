import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppPluginMeta } from '@grafana/data';
import { listClusters, listJobMetadataOptions, listJobs } from '../../api/slurmApi';
import { JobSearchPage } from './JobSearchPage';

jest.mock('../../api/slurmApi', () => ({
  listClusters: jest.fn(),
  listJobs: jest.fn(),
  listJobMetadataOptions: jest.fn(),
}));

jest.mock('../../storage/userPreferences', () => ({
  loadSearchPreferences: jest.fn(() => ({})),
  saveSearchPreferences: jest.fn(),
}));

const mockedListClusters = listClusters as jest.MockedFunction<typeof listClusters>;
const mockedListJobs = listJobs as jest.MockedFunction<typeof listJobs>;
const mockedListJobMetadataOptions = listJobMetadataOptions as jest.MockedFunction<typeof listJobMetadataOptions>;

describe('JobSearchPage', () => {
  beforeEach(() => {
    mockedListClusters.mockReset();
    mockedListJobs.mockReset();
    mockedListJobMetadataOptions.mockReset();
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
          instanceLabel: 'instance',
          nodeExporterPort: '9100',
          dcgmExporterPort: '9400',
          nodeMatcherMode: 'hostname',
          defaultTemplateId: 'overview',
          metricsFilterLabel: '',
          metricsFilterValue: '',
        },
      ],
    });
    mockedListJobs
      .mockResolvedValueOnce({ jobs: [] })
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
      });
    mockedListJobMetadataOptions.mockResolvedValue({ values: ['researcher1'] });

    render(<JobSearchPage meta={{} as AppPluginMeta} />);

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
          instanceLabel: 'instance',
          nodeExporterPort: '9100',
          dcgmExporterPort: '9400',
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
    });

    render(<JobSearchPage meta={{} as AppPluginMeta} />);

    expect(await screen.findByRole('heading', { name: 'Job Timeline' })).toBeInTheDocument();
    expect(screen.getByTestId('job-timeline-bar-10001')).toBeInTheDocument();
    expect(screen.getByText('gpu-a100 / researcher1 / 1 node')).toBeInTheDocument();
  });
});
