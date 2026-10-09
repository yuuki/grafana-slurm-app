import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ClusterSummary, JobRecord } from '../../api/types';
import { buildMetricPreviewScene } from '../JobDashboard/scenes/metricPanelsScene';
import { JobDetailModal } from './JobDetailModal';

jest.mock('../JobDashboard/scenes/metricPanelsScene', () => ({
  buildMetricPreviewScene: jest.fn(),
}));

const mockedBuild = buildMetricPreviewScene as jest.MockedFunction<typeof buildMetricPreviewScene>;
const job = { clusterId: 'a100', jobId: 42, name: 'train' } as JobRecord;
const cluster = { id: 'a100' } as ClusterSummary;

describe('JobDetailModal', () => {
  beforeEach(() => mockedBuild.mockReset());

  it('renders the per-GPU preview scene and links to the job dashboard', () => {
    const Component = () => <div data-testid="preview-scene" />;
    mockedBuild.mockReturnValue({ Component } as unknown as ReturnType<typeof buildMetricPreviewScene>);
    const onDismiss = jest.fn();
    render(<JobDetailModal job={job} cluster={cluster} metricName="DCGM_FI_DEV_GPU_UTIL" metricType="gauge" onDismiss={onDismiss} />);
    expect(screen.getByText('#42 train · DCGM_FI_DEV_GPU_UTIL')).toBeInTheDocument();
    expect(screen.getByTestId('preview-scene')).toBeInTheDocument();
    expect(mockedBuild).toHaveBeenCalledWith(
      job,
      cluster,
      expect.objectContaining({ metricName: 'DCGM_FI_DEV_GPU_UTIL', legendFormat: '{{instance}} / GPU {{gpu}}' }),
      'raw'
    );
    expect(screen.getByRole('link', { name: /Open job dashboard/ })).toHaveAttribute('href', '/a/yuuki-slurm-app/jobs/a100/42');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('explains when no preview can be built', () => {
    mockedBuild.mockReturnValue(null);
    render(<JobDetailModal job={job} cluster={cluster} metricName="up" metricType="gauge" onDismiss={jest.fn()} />);
    expect(screen.getByText('No query is available for this metric.')).toBeInTheDocument();
  });
});
