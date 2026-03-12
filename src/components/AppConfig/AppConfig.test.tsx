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
});
