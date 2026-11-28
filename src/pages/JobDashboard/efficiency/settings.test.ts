import { compactEfficiencySettings, EFFICIENCY_DEFAULTS, efficiencyDisabled, efficiencySettingsErrors, resolveEfficiencySettings } from './settings';

describe('efficiency settings', () => {
  it('uses the DCGM exporter defaults when nothing is configured', () => {
    expect(resolveEfficiencySettings(undefined)).toEqual(EFFICIENCY_DEFAULTS);
    expect(resolveEfficiencySettings({})).toEqual(EFFICIENCY_DEFAULTS);
    expect(EFFICIENCY_DEFAULTS).toEqual({
      gpuUtilizationMetric: 'DCGM_FI_DEV_GPU_UTIL',
      gpuMemoryUsedMetric: 'DCGM_FI_DEV_FB_USED',
      gpuMemoryFreeMetric: 'DCGM_FI_DEV_FB_FREE',
      gpuIdLabel: 'gpu',
      idleGpuUtilizationPercent: 5,
      lowGpuMemoryPercent: 15,
    });
  });

  it('overrides only the fields that are set and keeps an explicit 0', () => {
    expect(
      resolveEfficiencySettings({ gpuUtilizationMetric: 'nvidia_gpu_utilization', gpuIdLabel: '', idleGpuUtilizationPercent: 0 })
    ).toEqual({
      ...EFFICIENCY_DEFAULTS,
      gpuUtilizationMetric: 'nvidia_gpu_utilization',
      idleGpuUtilizationPercent: 0,
    });
  });

  it.each([
    [{ gpuUtilizationMetric: 'DCGM_FI_DEV_GPU_UTIL{gpu="0"}' }, 'GPU Utilization Metric must be a Prometheus metric name'],
    [{ gpuMemoryUsedMetric: 'used or vector(1)' }, 'GPU Memory Used Metric must be a Prometheus metric name'],
    [{ gpuMemoryFreeMetric: '9free' }, 'GPU Memory Free Metric must be a Prometheus metric name'],
    [{ gpuIdLabel: 'gpu,UUID' }, 'GPU ID Label must be a Prometheus label name'],
    [{ gpuIdLabel: 'gpu"' }, 'GPU ID Label must be a Prometheus label name'],
    [{ idleGpuUtilizationPercent: -1 }, 'Idle GPU Utilization (%) must be between 0 and 100'],
    [{ idleGpuUtilizationPercent: Number.NaN }, 'Idle GPU Utilization (%) must be between 0 and 100'],
    [{ lowGpuMemoryPercent: 100.1 }, 'Low GPU Memory (%) must be between 0 and 100'],
  ])('rejects %j', (settings, message) => {
    expect(efficiencySettingsErrors(settings)).toEqual([message]);
  });

  it('accepts unset fields, recording rule names, dotted labels and the range limits', () => {
    expect(efficiencySettingsErrors(undefined)).toEqual([]);
    expect(efficiencySettingsErrors({})).toEqual([]);
    expect(
      efficiencySettingsErrors({
        gpuUtilizationMetric: 'site:gpu_utilization:percent',
        gpuMemoryUsedMetric: '',
        gpuIdLabel: 'gpu.index',
        idleGpuUtilizationPercent: 0,
        lowGpuMemoryPercent: 100,
      })
    ).toEqual([]);
  });

  it('saves no efficiency object for a cluster that keeps every default', () => {
    expect(compactEfficiencySettings(undefined)).toBeUndefined();
    expect(compactEfficiencySettings({ gpuUtilizationMetric: '  ', gpuIdLabel: '', idleGpuUtilizationPercent: undefined })).toBeUndefined();
  });

  it('is on unless the cluster turns it off, and saves the switch only when it is off', () => {
    expect(efficiencyDisabled(undefined)).toBe(false);
    expect(efficiencyDisabled(null)).toBe(false);
    expect(efficiencyDisabled({})).toBe(false);
    expect(efficiencyDisabled({ disabled: false })).toBe(false);
    expect(efficiencyDisabled({ disabled: true })).toBe(true);

    expect(compactEfficiencySettings({ disabled: true })).toEqual({ disabled: true });
    expect(compactEfficiencySettings({ disabled: true, gpuIdLabel: 'minor_number' })).toEqual({ disabled: true, gpuIdLabel: 'minor_number' });
    expect(compactEfficiencySettings({ disabled: false })).toBeUndefined();
    expect(compactEfficiencySettings({ disabled: undefined })).toBeUndefined();
    // The switch does not make the other settings invalid, and they keep their meaning.
    expect(efficiencySettingsErrors({ disabled: true })).toEqual([]);
    expect(resolveEfficiencySettings({ disabled: true })).toEqual(EFFICIENCY_DEFAULTS);
  });

  it('trims names and keeps an explicit 0 when saving', () => {
    expect(
      compactEfficiencySettings({ gpuUtilizationMetric: ' my_gpu_util ', gpuIdLabel: 'minor_number', idleGpuUtilizationPercent: 0, lowGpuMemoryPercent: 20 })
    ).toEqual({ gpuUtilizationMetric: 'my_gpu_util', gpuIdLabel: 'minor_number', idleGpuUtilizationPercent: 0, lowGpuMemoryPercent: 20 });
  });
});
