/**
 * The job phase settings on the configuration page: what is saved under
 * clusters[].phases, and that a cluster that does not use the feature is
 * saved exactly as before, in both settings shapes.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppConfig } from './AppConfig';

const mockPost = jest.fn();

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({
    post: mockPost,
    get: jest.fn().mockResolvedValue([]),
  }),
}));

const connection = { id: 'default', dbHost: 'mysql:3306', dbName: 'slurm_acct_db', dbUser: 'slurm', securePasswordRef: 'dbPassword' };
const clusterA = { id: 'cluster-a', displayName: 'Cluster A', connectionId: 'default', slurmClusterName: 'cluster_a', metricsDatasourceUid: 'prom-a' };

function plugin(jsonData: Record<string, unknown>) {
  return { meta: { id: 'yuuki-slurm-app', jsonData, secureJsonFields: { dbPassword: true } } } as any;
}

function multiCluster(phases?: unknown) {
  return plugin({ connections: [connection], clusters: [phases === undefined ? clusterA : { ...clusterA, phases }] });
}

async function save(): Promise<any> {
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
  return mockPost.mock.calls[0][1].jsonData;
}

function openPhaseSettings(clusterLabel = 'Cluster A (cluster-a)') {
  fireEvent.click(screen.getByRole('button', { name: clusterLabel }));
  fireEvent.click(screen.getByRole('button', { name: 'Job Phases' }));
}

describe('AppConfig: job phase settings', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockPost.mockResolvedValue({});
  });

  it('saves no phases key for a cluster that does not use the feature (multi-cluster shape)', async () => {
    render(<AppConfig plugin={multiCluster()} />);
    const jsonData = await save();
    expect(jsonData.clusters).toHaveLength(1);
    expect(Object.keys(jsonData.clusters[0])).not.toContain('phases');
    expect(JSON.stringify(jsonData)).not.toContain('phases');
  });

  it('saves no phases key for the cluster migrated from the legacy single-cluster shape', async () => {
    render(<AppConfig plugin={plugin({ dbHost: 'legacy-db:3306', dbUser: 'slurm', clusterName: 'legacy_cluster', promDatasourceUid: 'prom-legacy' })} />);
    const jsonData = await save();
    expect(jsonData.clusters).toHaveLength(1);
    expect(jsonData.clusters[0]).toMatchObject({ id: 'legacy_cluster', slurmClusterName: 'legacy_cluster', metricsDatasourceUid: 'prom-legacy' });
    expect(JSON.stringify(jsonData)).not.toContain('phases');
  });

  it('drops an empty phases object instead of saving it', async () => {
    render(<AppConfig plugin={multiCluster({ enabled: false, gpuPowerMetric: '', storageWriteMetrics: [] })} />);
    const jsonData = await save();
    expect(JSON.stringify(jsonData)).not.toContain('phases');
  });

  it('keeps stored phase settings when other settings are saved', async () => {
    const phases = { enabled: true, gpuPowerMetric: 'gpu_power_watts', storageWriteMetrics: ['a_total', 'b_total'], idleGpuUtilizationPercent: 0, stallMinutes: 30 };
    render(<AppConfig plugin={multiCluster(phases)} />);
    const jsonData = await save();
    expect(jsonData.clusters[0].phases).toEqual(phases);
  });

  it('turns the feature on for a cluster with the defaults', async () => {
    render(<AppConfig plugin={multiCluster()} />);
    openPhaseSettings();
    const checkbox = screen.getByRole('checkbox', { name: 'Analyse job phases for this cluster' });
    expect(checkbox).not.toBeChecked();
    // The placeholders show the defaults that apply while a field is empty.
    expect(screen.getByPlaceholderText('DCGM_FI_DEV_POWER_USAGE')).toHaveValue('');
    expect(screen.getByPlaceholderText('DCGM_FI_DEV_GPU_UTIL')).toHaveValue('');
    expect(screen.getByPlaceholderText('node_disk_written_bytes_total')).toHaveValue('');

    fireEvent.click(checkbox);
    const jsonData = await save();
    expect(jsonData.clusters[0].phases).toEqual({ enabled: true });
  });

  it('saves edited metric names and thresholds, trimmed, and keeps a threshold of zero', async () => {
    render(<AppConfig plugin={multiCluster({ enabled: true })} />);
    openPhaseSettings();
    expect(screen.getByRole('checkbox', { name: 'Analyse job phases for this cluster' })).toBeChecked();
    fireEvent.change(screen.getByPlaceholderText('DCGM_FI_DEV_POWER_USAGE'), { target: { value: ' gpu_power_watts ' } });
    fireEvent.change(screen.getByPlaceholderText('node_disk_written_bytes_total'), { target: { value: 'node_disk_written_bytes_total, fs_write_bytes_total,' } });
    fireEvent.change(screen.getByPlaceholderText('5'), { target: { value: '0' } });
    fireEvent.change(screen.getByPlaceholderText('10'), { target: { value: '25' } });
    fireEvent.change(screen.getByPlaceholderText('1'), { target: { value: '0.5' } });

    const jsonData = await save();
    expect(jsonData.clusters[0].phases).toEqual({
      enabled: true,
      gpuPowerMetric: 'gpu_power_watts',
      storageWriteMetrics: ['node_disk_written_bytes_total', 'fs_write_bytes_total'],
      idleGpuUtilizationPercent: 0,
      stallMinutes: 25,
      checkpointMinWriteMibPerSecond: 0.5,
    });
  });

  it('turns the feature off again and keeps the configured values', async () => {
    render(<AppConfig plugin={multiCluster({ enabled: true, stallMinutes: 30 })} />);
    openPhaseSettings();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Analyse job phases for this cluster' }));
    const jsonData = await save();
    expect(jsonData.clusters[0].phases).toEqual({ stallMinutes: 30 });
  });

  it('returns a cleared field to its default', async () => {
    render(<AppConfig plugin={multiCluster({ enabled: true, gpuPowerMetric: 'gpu_power_watts', stallMinutes: 30, storageWriteMetrics: ['a_total'] })} />);
    openPhaseSettings();
    fireEvent.change(screen.getByDisplayValue('gpu_power_watts'), { target: { value: '' } });
    fireEvent.change(screen.getByDisplayValue('30'), { target: { value: '' } });
    fireEvent.change(screen.getByDisplayValue('a_total'), { target: { value: '' } });
    const jsonData = await save();
    expect(jsonData.clusters[0].phases).toEqual({ enabled: true });
  });

  it('does not save invalid phase settings and names the cluster and the field', async () => {
    render(<AppConfig plugin={multiCluster({ enabled: true })} />);
    openPhaseSettings();
    fireEvent.change(screen.getByPlaceholderText('DCGM_FI_DEV_GPU_UTIL'), { target: { value: 'up{} or vector(1)' } });
    fireEvent.change(screen.getByPlaceholderText('10'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(
      await screen.findByText(
        'Please fix the following errors before saving: Cluster "cluster-a": GPU Utilization Metric must be a Prometheus metric name; Cluster "cluster-a": Stall Time (minutes) must be between 1 and 1440'
      )
    ).toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();
  });

  describe('stored phase settings that are not valid', () => {
    const warning = 'The stored Job Phases settings of a cluster are not valid, so job phases are off for that cluster';

    it('shows no warning for valid or absent stored settings, in both settings shapes', () => {
      for (const item of [multiCluster(), multiCluster({ enabled: true, stallMinutes: 20 }), plugin({ dbHost: 'mysql:3306', clusterName: 'legacy_cluster' })]) {
        const { unmount } = render(<AppConfig plugin={item} />);
        expect(screen.queryByText(warning)).not.toBeInTheDocument();
        unmount();
      }
    });

    it('names the cluster and the value that is out of range as soon as the page opens, and keeps the value for correction', async () => {
      render(<AppConfig plugin={multiCluster({ stallMinutes: 0 })} />);
      const alert = screen.getByText(warning).closest('[role="alert"], [data-testid]') ?? document.body;
      expect(alert).toHaveTextContent('Cluster "cluster-a": Stall Time (minutes) must be between 1 and 1440. Correct the values under the cluster\'s Job Phases settings and save.');
      openPhaseSettings();
      expect(screen.getByPlaceholderText('10')).toHaveValue(0);
      fireEvent.change(screen.getByPlaceholderText('10'), { target: { value: '20' } });
      expect((await save()).clusters[0].phases).toEqual({ stallMinutes: 20 });
      // Saved with valid values: the warning about the stored values is gone.
      expect(screen.queryByText(warning)).not.toBeInTheDocument();
    });

    it.each([
      ['enabled as text', { enabled: 'yes' }, 'Analyse job phases must be true or false'],
      ['a threshold as text', { enabled: true, stallMinutes: '10' }, 'Stall Time (minutes) must be a number'],
      ['storage metrics as one text', { storageWriteMetrics: 'node_disk_written_bytes_total' }, 'Storage Write Metrics must be a list of texts'],
      ['a metric name as a number', { gpuPowerMetric: 7 }, 'GPU Power Metric must be a text'],
      ['phases as text', 'on', 'the stored value is not an object'],
      ['phases as a list', ['enabled'], 'the stored value is not an object'],
    ])('opens with %s, says what is wrong, and saves without the value of the wrong type', async (_name, phases, problem) => {
      render(<AppConfig plugin={multiCluster(phases)} />);
      expect(document.body).toHaveTextContent(`Cluster "cluster-a": ${problem}`);
      // The editor opens; a value of the wrong type is not shown as if it were set.
      openPhaseSettings();
      expect(screen.getByPlaceholderText('node_disk_written_bytes_total')).toHaveValue('');
      const saved = (await save()).clusters[0];
      const kept = typeof phases === 'object' && !Array.isArray(phases) && phases.enabled === true ? { enabled: true } : undefined;
      expect(saved.phases).toEqual(kept);
    });

    it('lists every cluster with a problem', () => {
      const other = { ...clusterA, id: 'cluster-b', displayName: 'Cluster B', phases: { idleGpuUtilizationPercent: 80 } };
      render(<AppConfig plugin={plugin({ connections: [connection], clusters: [{ ...clusterA, phases: { enabled: 1 } }, other] })} />);
      expect(document.body).toHaveTextContent(
        'Cluster "cluster-a": Analyse job phases must be true or false. Cluster "cluster-b": Idle GPU Utilization (%) must be between 0 and 50.'
      );
    });
  });

  it('does not save invalid settings of a cluster whose feature is off either, because the backend would turn the phases off', async () => {
    render(<AppConfig plugin={multiCluster({ stallMinutes: 5000 })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText(/Please fix the following errors before saving: Cluster "cluster-a": Stall Time \(minutes\) must be between 1 and 1440/)).toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();
  });
});
