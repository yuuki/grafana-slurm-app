import { EfficiencySettings } from '../../../api/types';

/** Efficiency settings with every default filled in. */
export interface ResolvedEfficiencySettings {
  gpuUtilizationMetric: string;
  gpuMemoryUsedMetric: string;
  gpuMemoryFreeMetric: string;
  gpuIdLabel: string;
  idleGpuUtilizationPercent: number;
  lowGpuMemoryPercent: number;
}

/**
 * The defaults are the names of the NVIDIA DCGM exporter, which the plugin
 * requires for GPU metrics (see README). docs/job-efficiency.md gives the
 * reason for each threshold.
 */
export const EFFICIENCY_DEFAULTS: ResolvedEfficiencySettings = {
  gpuUtilizationMetric: 'DCGM_FI_DEV_GPU_UTIL',
  gpuMemoryUsedMetric: 'DCGM_FI_DEV_FB_USED',
  gpuMemoryFreeMetric: 'DCGM_FI_DEV_FB_FREE',
  gpuIdLabel: 'gpu',
  idleGpuUtilizationPercent: 5,
  lowGpuMemoryPercent: 15,
};

// The same rules as EfficiencySettings.Validate in
// pkg/plugin/settings/efficiency.go. Metric names go into PromQL unquoted,
// so only the classic metric name characters are accepted.
const METRIC_NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;

const METRIC_FIELDS = ['gpuUtilizationMetric', 'gpuMemoryUsedMetric', 'gpuMemoryFreeMetric'] as const;
const PERCENT_FIELDS = ['idleGpuUtilizationPercent', 'lowGpuMemoryPercent'] as const;

/** Field names as the cluster settings page shows them. */
export const EFFICIENCY_FIELD_LABELS: Record<keyof ResolvedEfficiencySettings, string> = {
  gpuUtilizationMetric: 'GPU Utilization Metric',
  gpuMemoryUsedMetric: 'GPU Memory Used Metric',
  gpuMemoryFreeMetric: 'GPU Memory Free Metric',
  gpuIdLabel: 'GPU ID Label',
  idleGpuUtilizationPercent: 'Idle GPU Utilization (%)',
  lowGpuMemoryPercent: 'Low GPU Memory (%)',
};

function isUnset(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * Returns one message per invalid field; an unset field is valid. The
 * settings page calls it before saving and the scorecard before querying.
 */
export function efficiencySettingsErrors(settings?: EfficiencySettings | null): string[] {
  if (!settings) {
    return [];
  }
  const errors: string[] = [];
  for (const field of METRIC_FIELDS) {
    const value = settings[field];
    if (!isUnset(value) && !(typeof value === 'string' && METRIC_NAME_PATTERN.test(value))) {
      errors.push(`${EFFICIENCY_FIELD_LABELS[field]} must be a Prometheus metric name`);
    }
  }
  if (!isUnset(settings.gpuIdLabel) && !(typeof settings.gpuIdLabel === 'string' && LABEL_NAME_PATTERN.test(settings.gpuIdLabel))) {
    errors.push(`${EFFICIENCY_FIELD_LABELS.gpuIdLabel} must be a Prometheus label name`);
  }
  for (const field of PERCENT_FIELDS) {
    const value = settings[field];
    if (!isUnset(value) && !(typeof value === 'number' && value >= 0 && value <= 100)) {
      errors.push(`${EFFICIENCY_FIELD_LABELS[field]} must be between 0 and 100`);
    }
  }
  return errors;
}

/**
 * True when job efficiency is turned off for the cluster. The scorecard
 * and the idle GPU column of Job Search are then not shown, and none of
 * their queries is sent.
 */
export function efficiencyDisabled(settings?: EfficiencySettings | null): boolean {
  return settings?.disabled === true;
}

/** Fills in the default of every unset field. An explicit 0 is kept. */
export function resolveEfficiencySettings(settings?: EfficiencySettings | null): ResolvedEfficiencySettings {
  const resolved = { ...EFFICIENCY_DEFAULTS };
  if (!settings) {
    return resolved;
  }
  for (const field of [...METRIC_FIELDS, 'gpuIdLabel'] as const) {
    const value = settings[field];
    if (typeof value === 'string' && value !== '') {
      resolved[field] = value;
    }
  }
  for (const field of PERCENT_FIELDS) {
    const value = settings[field];
    if (typeof value === 'number' && Number.isFinite(value)) {
      resolved[field] = value;
    }
  }
  return resolved;
}

/**
 * Drops the unset fields, so a cluster that keeps every default is saved
 * without an efficiency object. Returns undefined when nothing is set.
 */
export function compactEfficiencySettings(settings?: EfficiencySettings | null): EfficiencySettings | undefined {
  if (!settings) {
    return undefined;
  }
  const compact: EfficiencySettings = {};
  if (settings.disabled === true) {
    compact.disabled = true;
  }
  for (const field of [...METRIC_FIELDS, 'gpuIdLabel'] as const) {
    const value = settings[field];
    if (typeof value === 'string' && value.trim() !== '') {
      compact[field] = value.trim();
    }
  }
  for (const field of PERCENT_FIELDS) {
    const value = settings[field];
    if (typeof value === 'number' && !Number.isNaN(value)) {
      compact[field] = value;
    }
  }
  return Object.keys(compact).length > 0 ? compact : undefined;
}
