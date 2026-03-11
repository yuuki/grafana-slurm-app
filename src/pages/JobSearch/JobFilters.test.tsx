import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { listJobMetadataOptions } from '../../api/slurmApi';
import { ClusterSummary } from '../../api/types';
import { JobFilters } from './JobFilters';

jest.mock('../../api/slurmApi', () => ({
  listJobMetadataOptions: jest.fn(),
}));

const mockedListJobMetadataOptions = listJobMetadataOptions as jest.MockedFunction<typeof listJobMetadataOptions>;

const cluster: ClusterSummary = {
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
};

describe('JobFilters', () => {
  beforeEach(() => {
    mockedListJobMetadataOptions.mockReset();
  });

  it('clears direct lookup when a metadata field is edited manually', () => {
    const onChange = jest.fn();

    render(
      <JobFilters
        clusters={[cluster]}
        filters={{ clusterId: 'a100', jobId: '10001', user: '' }}
        loadingClusters={false}
        onChange={onChange}
        onSelectMetadata={jest.fn()}
        onSearch={jest.fn()}
        onOpenJob={jest.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('Username'), { target: { value: 'research' } });

    expect(onChange).toHaveBeenCalledWith({
      clusterId: 'a100',
      jobId: '',
      user: 'research',
    });
  });

  it('loads suggestions on focus and selects the highlighted option with Enter', async () => {
    const onSelectMetadata = jest.fn();
    mockedListJobMetadataOptions.mockResolvedValue({ values: ['researcher1', 'researcher2'] });

    render(
      <JobFilters
        clusters={[cluster]}
        filters={{ clusterId: 'a100', user: '' }}
        loadingClusters={false}
        onChange={jest.fn()}
        onSelectMetadata={onSelectMetadata}
        onSearch={jest.fn()}
        onOpenJob={jest.fn()}
      />
    );

    const input = screen.getByPlaceholderText('Username');
    fireEvent.focus(input);

    await waitFor(() => {
      expect(mockedListJobMetadataOptions).toHaveBeenCalledWith({
        clusterId: 'a100',
        field: 'user',
        limit: 50,
      });
    });

    await screen.findByRole('option', { name: 'researcher1' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSelectMetadata).toHaveBeenCalledWith('user', 'researcher1');
  });
});
