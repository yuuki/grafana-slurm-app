import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppConfig } from './AppConfig';

const mockPost = jest.fn();

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({
    post: mockPost,
  }),
}));

describe('AppConfig', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockPost.mockResolvedValue({});
  });

  it('does not render deprecated exporter port settings in cluster profiles', () => {
    render(
      <AppConfig
        plugin={{
          meta: {
            id: 'yuuki-slurm-app',
            jsonData: {
              connections: [
                {
                  id: 'default',
                  dbHost: 'mysql:3306',
                  dbName: 'slurm_acct_db',
                  dbUser: 'slurm',
                  securePasswordRef: 'dbPassword',
                },
              ],
              clusters: [
                {
                  id: 'a100',
                  displayName: 'A100 Cluster',
                  connectionId: 'default',
                  slurmClusterName: 'gpu_cluster',
                  metricsDatasourceUid: 'prom-main',
                  nodeExporterPort: '19100',
                  dcgmExporterPort: '19400',
                },
              ],
            },
            secureJsonFields: {
              dbPassword: true,
            },
          },
        } as any}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'A100 Cluster (a100)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Metrics Settings' }));

    expect(screen.getByDisplayValue('prom-main')).toBeInTheDocument();
    expect(screen.getByDisplayValue('instance')).toBeInTheDocument();
    expect(screen.queryByLabelText('Node Exporter Port')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('DCGM Exporter Port')).not.toBeInTheDocument();
  });

  it('saves metricsifter service url in plugin settings payload', async () => {
    render(
      <AppConfig
        plugin={{
          meta: {
            id: 'yuuki-slurm-app',
            jsonData: {
              metricsifterServiceUrl: '',
              connections: [
                {
                  id: 'default',
                  dbHost: 'mysql:3306',
                  dbName: 'slurm_acct_db',
                  dbUser: 'slurm',
                  securePasswordRef: 'dbPassword',
                },
              ],
              clusters: [
                {
                  id: 'a100',
                  displayName: 'A100 Cluster',
                  connectionId: 'default',
                  slurmClusterName: 'gpu_cluster',
                  metricsDatasourceUid: 'prom-main',
                },
              ],
            },
            secureJsonFields: {
              dbPassword: true,
            },
          },
        } as any}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('http://metricsifter:8000'), {
      target: { value: 'http://metricsifter:8000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/api/plugins/yuuki-slurm-app/settings', expect.objectContaining({
        jsonData: expect.objectContaining({
          metricsifterServiceUrl: 'http://metricsifter:8000',
        }),
      }))
    );
  });

  it('saves metricsifter default params in plugin settings payload', async () => {
    render(
      <AppConfig
        plugin={{
          meta: {
            id: 'yuuki-slurm-app',
            jsonData: {
              metricsifterServiceUrl: 'http://metricsifter:8000',
              connections: [
                {
                  id: 'default',
                  dbHost: 'mysql:3306',
                  dbName: 'slurm_acct_db',
                  dbUser: 'slurm',
                  securePasswordRef: 'dbPassword',
                },
              ],
              clusters: [
                {
                  id: 'a100',
                  displayName: 'A100 Cluster',
                  connectionId: 'default',
                  slurmClusterName: 'gpu_cluster',
                  metricsDatasourceUid: 'prom-main',
                },
              ],
            },
            secureJsonFields: {
              dbPassword: true,
            },
          },
        } as any}
      />
    );

    const penaltyAdjustInput = screen.getByLabelText('Penalty adjust');
    fireEvent.change(penaltyAdjustInput, { target: { value: '3.5' } });
    fireEvent.blur(penaltyAdjustInput);
    fireEvent.click(screen.getByRole('radio', { name: 'Numeric' }));
    const penaltyValueInput = screen.getByLabelText('Penalty value');
    fireEvent.change(penaltyValueInput, { target: { value: '12.5' } });
    fireEvent.blur(penaltyValueInput);
    fireEvent.click(screen.getByLabelText('Skip simple filter'));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/api/plugins/yuuki-slurm-app/settings', expect.objectContaining({
        jsonData: expect.objectContaining({
          metricsifterDefaultParams: expect.objectContaining({
            penaltyAdjust: 3.5,
            penalty: 12.5,
            withoutSimpleFilter: true,
          }),
        }),
      }))
    );
  });

  it('removes deprecated exporter port settings from saved cluster payloads', async () => {
    render(
      <AppConfig
        plugin={{
          meta: {
            id: 'yuuki-slurm-app',
            jsonData: {
              connections: [
                {
                  id: 'default',
                  dbHost: 'mysql:3306',
                  dbName: 'slurm_acct_db',
                  dbUser: 'slurm',
                  securePasswordRef: 'dbPassword',
                },
              ],
              clusters: [
                {
                  id: 'a100',
                  displayName: 'A100 Cluster',
                  connectionId: 'default',
                  slurmClusterName: 'gpu_cluster',
                  metricsDatasourceUid: 'prom-main',
                  nodeExporterPort: '19100',
                  dcgmExporterPort: '19400',
                },
              ],
            },
            secureJsonFields: {
              dbPassword: true,
            },
          },
        } as any}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));

    const payload = mockPost.mock.calls[0][1];
    expect(payload.jsonData.clusters[0]).not.toHaveProperty('nodeExporterPort');
    expect(payload.jsonData.clusters[0]).not.toHaveProperty('dcgmExporterPort');
  });
});
