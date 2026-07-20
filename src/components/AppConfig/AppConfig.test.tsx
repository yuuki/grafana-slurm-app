import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AppConfig } from './AppConfig';

const mockPost = jest.fn();

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({
    post: mockPost,
  }),
}));

function labelingPlugin(categories: string[] = ['maintenance']) {
  return {
    meta: {
      id: 'yuuki-slurm-app',
      jsonData: {
        annotationLabeling: {
          enabled: true,
          categories,
        },
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
  } as any;
}

function pluginWithoutAnnotationLabeling() {
  const plugin = labelingPlugin();
  delete plugin.meta.jsonData.annotationLabeling;
  return plugin;
}

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

  it('enables annotation labeling without additional cluster settings', async () => {
    render(<AppConfig plugin={labelingPlugin()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost.mock.calls[0][1].jsonData.annotationLabeling).toEqual({
      enabled: true,
      categories: ['maintenance'],
    });
    const savedCluster = mockPost.mock.calls[0][1].jsonData.clusters[0];
    expect(savedCluster).toEqual(expect.objectContaining({
      id: 'a100',
      displayName: 'A100 Cluster',
      connectionId: 'default',
      slurmClusterName: 'gpu_cluster',
      metricsDatasourceUid: 'prom-main',
    }));
    expect(Object.keys(savedCluster)).toEqual([
      'id',
      'displayName',
      'connectionId',
      'slurmClusterName',
      'metricsDatasourceUid',
      'metricsType',
      'aggregationNodeLabels',
      'instanceLabel',
      'nodeMatcherMode',
      'defaultTemplateId',
      'metricsFilterLabel',
      'metricsFilterValue',
      'cpuUtilizationExpr',
      'gpuUtilizationExpr',
      'accessRule',
    ]);
  });

  it('saves an empty category list without replacing it with defaults', async () => {
    render(<AppConfig plugin={labelingPlugin([])} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost.mock.calls[0][1].jsonData.annotationLabeling).toEqual({
      enabled: true,
      categories: [],
    });
  });

  it('saves disabled labeling with empty categories when annotation labeling is not configured', async () => {
    render(<AppConfig plugin={pluginWithoutAnnotationLabeling()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost.mock.calls[0][1].jsonData.annotationLabeling).toEqual({
      enabled: false,
      categories: [],
    });
  });

  it('trims, removes empty values, and deduplicates custom categories before saving', async () => {
    render(<AppConfig plugin={labelingPlugin()} />);

    fireEvent.change(screen.getByDisplayValue('maintenance'), {
      target: { value: ' maintenance, custom category, , maintenance, incident ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost.mock.calls[0][1].jsonData.annotationLabeling).toEqual({
      enabled: true,
      categories: ['maintenance', 'custom category', 'incident'],
    });
  });

  it('renders only generic annotation labeling settings', () => {
    render(<AppConfig plugin={labelingPlugin()} />);

    const section = screen.getByRole('group', { name: 'Annotation Labeling' });
    expect(within(section).getByText('Enable annotation labeling')).toBeInTheDocument();
    expect(within(section).getByRole('switch')).toBeChecked();
    expect(within(section).getByRole('textbox', { name: 'Categories' })).toBeInTheDocument();
    expect(within(section).getAllByRole('switch')).toHaveLength(1);
    expect(within(section).getAllByRole('textbox')).toHaveLength(1);
    expect(within(section).getByText(/Grafana annotation RBAC/)).toBeInTheDocument();
  });
});
