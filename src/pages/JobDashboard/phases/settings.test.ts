import { DEFAULT_PHASE_THRESHOLDS } from './segment';
import { compactPhaseSettings, isPhaseMetricName, phaseSettingsErrors, readStoredPhaseSettings, resolvePhaseSettings } from './settings';
import type { PhaseSettings } from '../../../api/types';

describe('isPhaseMetricName', () => {
  it.each(['DCGM_FI_DEV_POWER_USAGE', 'node_disk_written_bytes_total', '_a', 'job:write:rate5m', 'a'.repeat(200)])('accepts %s', (name) => {
    expect(isPhaseMetricName(name)).toBe(true);
  });

  it.each(['', 'up{}', 'a b', 'a-b', '9a', 'a.b', 'a"', 'a|b', 'rate(a[5m])', 'a'.repeat(201), 'é', 'a\nb', 'a\nup{}', 'up{}\na', 'a\n'])('rejects %j', (name) => {
    expect(isPhaseMetricName(name)).toBe(false);
  });

  it('rejects values that are not text', () => {
    expect(isPhaseMetricName(undefined)).toBe(false);
    expect(isPhaseMetricName(5)).toBe(false);
  });
});

describe('compactPhaseSettings', () => {
  it('returns undefined for settings that say nothing', () => {
    expect(compactPhaseSettings(undefined)).toBeUndefined();
    expect(compactPhaseSettings({})).toBeUndefined();
    expect(compactPhaseSettings({ enabled: false, gpuPowerMetric: ' ', gpuUtilizationMetric: '', storageWriteMetrics: [' ', ''] })).toBeUndefined();
  });

  it('trims names, drops empty ones and keeps a threshold of zero', () => {
    expect(
      compactPhaseSettings({
        enabled: true,
        gpuPowerMetric: ' gpu_power ',
        gpuUtilizationMetric: '',
        storageWriteMetrics: [' a_total', '', 'b_total '],
        idleGpuUtilizationPercent: 0,
        stallMinutes: undefined,
        checkpointMinWriteMibPerSecond: 0,
      })
    ).toEqual({
      enabled: true,
      gpuPowerMetric: 'gpu_power',
      storageWriteMetrics: ['a_total', 'b_total'],
      idleGpuUtilizationPercent: 0,
      checkpointMinWriteMibPerSecond: 0,
    });
  });

  it('keeps configured values of a cluster that is turned off', () => {
    expect(compactPhaseSettings({ enabled: false, stallMinutes: 20 })).toEqual({ stallMinutes: 20 });
  });
});

describe('phaseSettingsErrors', () => {
  it('accepts unset fields and the limits', () => {
    expect(phaseSettingsErrors(undefined)).toEqual([]);
    expect(phaseSettingsErrors({ enabled: true })).toEqual([]);
    expect(phaseSettingsErrors({ idleGpuUtilizationPercent: 0, stallMinutes: 1, checkpointMinWriteMibPerSecond: 0 })).toEqual([]);
    expect(phaseSettingsErrors({ idleGpuUtilizationPercent: 50, stallMinutes: 1440, checkpointMinWriteMibPerSecond: 1048576 })).toEqual([]);
    expect(phaseSettingsErrors({ storageWriteMetrics: ['a', 'b', 'c', 'd'] })).toEqual([]);
  });

  it('names every invalid field', () => {
    expect(
      phaseSettingsErrors({
        gpuPowerMetric: 'power{gpu="0"}',
        gpuUtilizationMetric: 'a or b',
        storageWriteMetrics: ['ok_total', 'bad}'],
        idleGpuUtilizationPercent: 50.1,
        stallMinutes: 0,
        checkpointMinWriteMibPerSecond: -1,
      })
    ).toEqual([
      'GPU Power Metric must be a Prometheus metric name',
      'GPU Utilization Metric must be a Prometheus metric name',
      'Storage Write Metrics must be Prometheus metric names',
      'Idle GPU Utilization (%) must be between 0 and 50',
      'Stall Time (minutes) must be between 1 and 1440',
      'Smallest Checkpoint Write Rate (MiB/s) must be between 0 and 1048576',
    ]);
  });

  it('rejects too many or repeated storage write metrics', () => {
    expect(phaseSettingsErrors({ storageWriteMetrics: ['a', 'b', 'c', 'd', 'e'] })).toEqual(['Storage Write Metrics must name at most 4 metrics']);
    expect(phaseSettingsErrors({ storageWriteMetrics: ['a', 'a'] })).toEqual(['Storage Write Metrics must not repeat a metric']);
  });

  it('rejects values of the wrong type that a hand-written settings file could hold', () => {
    const settings = { storageWriteMetrics: 'node_disk_written_bytes_total', stallMinutes: '10', idleGpuUtilizationPercent: NaN } as unknown as PhaseSettings;
    expect(phaseSettingsErrors(settings)).toEqual([
      'Storage Write Metrics must be Prometheus metric names',
      'Idle GPU Utilization (%) must be between 0 and 50',
      'Stall Time (minutes) must be between 1 and 1440',
    ]);
  });
});

describe('resolvePhaseSettings', () => {
  it('is off without the settings, with empty settings and without enabled: true', () => {
    expect(resolvePhaseSettings(undefined)).toEqual({ state: 'off' });
    expect(resolvePhaseSettings({})).toEqual({ state: 'off' });
    expect(resolvePhaseSettings({ enabled: false, stallMinutes: 20 })).toEqual({ state: 'off' });
    expect(resolvePhaseSettings({ enabled: 'yes' } as unknown as PhaseSettings)).toEqual({ state: 'off' });
    // Invalid settings of a cluster that is off stay off: nothing is shown.
    expect(resolvePhaseSettings({ stallMinutes: 0 })).toEqual({ state: 'off' });
  });

  it('applies the defaults, which are the defaults of the segmentation', () => {
    expect(resolvePhaseSettings({ enabled: true })).toEqual({
      state: 'on',
      settings: {
        gpuPowerMetric: 'DCGM_FI_DEV_POWER_USAGE',
        gpuUtilizationMetric: 'DCGM_FI_DEV_GPU_UTIL',
        storageWriteMetrics: ['node_disk_written_bytes_total'],
        thresholds: DEFAULT_PHASE_THRESHOLDS,
      },
    });
  });

  it('converts minutes and MiB/s and keeps a threshold of zero', () => {
    const resolved = resolvePhaseSettings({
      enabled: true,
      gpuPowerMetric: 'gpu_power',
      storageWriteMetrics: ['a_total', 'b_total'],
      idleGpuUtilizationPercent: 0,
      stallMinutes: 2.5,
      checkpointMinWriteMibPerSecond: 0,
    });
    expect(resolved).toEqual({
      state: 'on',
      settings: {
        gpuPowerMetric: 'gpu_power',
        gpuUtilizationMetric: 'DCGM_FI_DEV_GPU_UTIL',
        storageWriteMetrics: ['a_total', 'b_total'],
        thresholds: { idleGpuUtilizationPercent: 0, stallMinSeconds: 150, checkpointMinWriteBytesPerSecond: 0 },
      },
    });
  });

  it('is invalid, not on, when an enabled cluster has an invalid value', () => {
    expect(resolvePhaseSettings({ enabled: true, gpuUtilizationMetric: 'up{}' })).toEqual({
      state: 'invalid',
      errors: ['GPU Utilization Metric must be a Prometheus metric name'],
    });
  });
});

describe('readStoredPhaseSettings', () => {
  it('reads nothing from an absent value', () => {
    expect(readStoredPhaseSettings(undefined)).toEqual({ settings: undefined, problems: [] });
    expect(readStoredPhaseSettings(null)).toEqual({ settings: undefined, problems: [] });
    expect(readStoredPhaseSettings({})).toEqual({ settings: undefined, problems: [] });
  });

  it('keeps valid settings as they are', () => {
    const stored = { enabled: true, gpuPowerMetric: 'gpu_power', storageWriteMetrics: ['a_total'], idleGpuUtilizationPercent: 0, stallMinutes: 20 };
    expect(readStoredPhaseSettings(stored)).toEqual({ settings: stored, problems: [] });
  });

  it.each([['on'], [5], [true], [['enabled']]])('reports a value that is not an object: %j', (raw) => {
    expect(readStoredPhaseSettings(raw)).toEqual({ settings: undefined, problems: ['the stored value is not an object'] });
  });

  it('leaves out fields of the wrong type, names them, and keeps the others', () => {
    expect(
      readStoredPhaseSettings({
        enabled: 'yes',
        gpuPowerMetric: 7,
        gpuUtilizationMetric: 'gpu_util',
        storageWriteMetrics: 'node_disk_written_bytes_total',
        idleGpuUtilizationPercent: '5',
        stallMinutes: 20,
        checkpointMinWriteMibPerSecond: [1],
      })
    ).toEqual({
      settings: { gpuUtilizationMetric: 'gpu_util', stallMinutes: 20 },
      problems: [
        'Analyse job phases must be true or false',
        'GPU Power Metric must be a text',
        'Storage Write Metrics must be a list of texts',
        'Idle GPU Utilization (%) must be a number',
        'Smallest Checkpoint Write Rate (MiB/s) must be a number',
      ],
    });
    expect(readStoredPhaseSettings({ storageWriteMetrics: ['a_total', 3] }).problems).toEqual(['Storage Write Metrics must be a list of texts']);
  });

  it('keeps a value that is out of range, so that it can be corrected, and reports it', () => {
    expect(readStoredPhaseSettings({ enabled: true, stallMinutes: 0, gpuUtilizationMetric: 'up{} or vector(1)' })).toEqual({
      settings: { enabled: true, stallMinutes: 0, gpuUtilizationMetric: 'up{} or vector(1)' },
      problems: ['GPU Utilization Metric must be a Prometheus metric name', 'Stall Time (minutes) must be between 1 and 1440'],
    });
  });
});
