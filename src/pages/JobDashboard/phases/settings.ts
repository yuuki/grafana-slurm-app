/**
 * Settings of the job phase segmentation: the defaults, the validation that
 * the settings page and the Job Dashboard share, and the effective values.
 *
 * The backend validates the same rules (pkg/plugin/settings/phases.go). The
 * checks are repeated here because the metric names go into PromQL unquoted:
 * the Job Dashboard sends no query for settings that fail them.
 */
import { PhaseSettings } from '../../../api/types';
import { PhaseThresholds } from './types';

/** The defaults match the NVIDIA DCGM exporter and node_exporter. */
export const PHASE_SETTING_DEFAULTS = {
  gpuPowerMetric: 'DCGM_FI_DEV_POWER_USAGE',
  gpuUtilizationMetric: 'DCGM_FI_DEV_GPU_UTIL',
  storageWriteMetrics: ['node_disk_written_bytes_total'],
  idleGpuUtilizationPercent: 5,
  stallMinutes: 10,
  checkpointMinWriteMibPerSecond: 1,
} as const;

export const PHASE_SETTING_LIMITS = {
  maxStorageWriteMetrics: 4,
  maxMetricNameLength: 200,
  idleGpuUtilizationPercent: { min: 0, max: 50 },
  stallMinutes: { min: 1, max: 24 * 60 },
  checkpointMinWriteMibPerSecond: { min: 0, max: 1024 * 1024 },
} as const;

/** node_exporter's CPU counter; not configurable, like the plugin's other CPU queries. */
export const CPU_METRIC = 'node_cpu_seconds_total';

/** node_exporter's network counters. They are shown as evidence and decide no phase, so they are not configurable. */
export const NETWORK_METRICS: readonly string[] = [
  'node_network_receive_bytes_total',
  'node_network_transmit_bytes_total',
  'node_infiniband_port_data_received_bytes_total',
  'node_infiniband_port_data_transmitted_bytes_total',
];

const METRIC_NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

export function isPhaseMetricName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= PHASE_SETTING_LIMITS.maxMetricNameLength && METRIC_NAME_PATTERN.test(name);
}

type RangeField = 'idleGpuUtilizationPercent' | 'stallMinutes' | 'checkpointMinWriteMibPerSecond';

export const PHASE_FIELD_LABELS: Record<keyof Omit<PhaseSettings, 'enabled'>, string> = {
  gpuPowerMetric: 'GPU Power Metric',
  gpuUtilizationMetric: 'GPU Utilization Metric',
  storageWriteMetrics: 'Storage Write Metrics',
  idleGpuUtilizationPercent: 'Idle GPU Utilization (%)',
  stallMinutes: 'Stall Time (minutes)',
  checkpointMinWriteMibPerSecond: 'Smallest Checkpoint Write Rate (MiB/s)',
};

function rangeError(settings: PhaseSettings, field: RangeField): string | null {
  const value = settings[field];
  if (value === undefined) {
    return null;
  }
  const { min, max } = PHASE_SETTING_LIMITS[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    return `${PHASE_FIELD_LABELS[field]} must be between ${min} and ${max}`;
  }
  return null;
}

function storageWriteMetricsError(metrics: unknown): string | null {
  if (metrics === undefined) {
    return null;
  }
  if (!Array.isArray(metrics) || !metrics.every(isPhaseMetricName)) {
    return `${PHASE_FIELD_LABELS.storageWriteMetrics} must be Prometheus metric names`;
  }
  if (metrics.length > PHASE_SETTING_LIMITS.maxStorageWriteMetrics) {
    return `${PHASE_FIELD_LABELS.storageWriteMetrics} must name at most ${PHASE_SETTING_LIMITS.maxStorageWriteMetrics} metrics`;
  }
  if (new Set(metrics).size !== metrics.length) {
    return `${PHASE_FIELD_LABELS.storageWriteMetrics} must not repeat a metric`;
  }
  return null;
}

/** The problems of a compacted settings object; empty when it is valid. */
export function phaseSettingsErrors(settings: PhaseSettings | undefined): string[] {
  if (!settings) {
    return [];
  }
  const errors: Array<string | null> = [];
  for (const field of ['gpuPowerMetric', 'gpuUtilizationMetric'] as const) {
    if (settings[field] !== undefined && !isPhaseMetricName(settings[field])) {
      errors.push(`${PHASE_FIELD_LABELS[field]} must be a Prometheus metric name`);
    }
  }
  errors.push(storageWriteMetricsError(settings.storageWriteMetrics));
  for (const field of ['idleGpuUtilizationPercent', 'stallMinutes', 'checkpointMinWriteMibPerSecond'] as const) {
    errors.push(rangeError(settings, field));
  }
  return errors.filter((error): error is string => error !== null);
}

function trimmed<T>(value: T): T | string {
  return typeof value === 'string' ? value.trim() : value;
}

/** The storage write metrics without empty entries; undefined when none is left. A value of the wrong type is kept for the validation to report. */
function compactMetrics(metrics: PhaseSettings['storageWriteMetrics']): PhaseSettings['storageWriteMetrics'] {
  if (!Array.isArray(metrics)) {
    return metrics;
  }
  const names = metrics.map(trimmed).filter((name) => name !== '');
  return names.length > 0 ? names : undefined;
}

/**
 * The settings as they are saved: without empty fields, and undefined when
 * nothing is left. A cluster that does not use the feature then carries no
 * phases key at all.
 */
export function compactPhaseSettings(settings: PhaseSettings | undefined): PhaseSettings | undefined {
  if (!settings) {
    return undefined;
  }
  const candidate: PhaseSettings = {
    enabled: settings.enabled === true ? true : undefined,
    gpuPowerMetric: trimmed(settings.gpuPowerMetric),
    gpuUtilizationMetric: trimmed(settings.gpuUtilizationMetric),
    storageWriteMetrics: compactMetrics(settings.storageWriteMetrics),
    idleGpuUtilizationPercent: settings.idleGpuUtilizationPercent,
    stallMinutes: settings.stallMinutes,
    checkpointMinWriteMibPerSecond: settings.checkpointMinWriteMibPerSecond,
  };
  const entries = Object.entries(candidate).filter(([, value]) => value !== undefined && value !== null && value !== '');
  return entries.length > 0 ? (Object.fromEntries(entries) as PhaseSettings) : undefined;
}

export interface EffectivePhaseSettings {
  gpuPowerMetric: string;
  gpuUtilizationMetric: string;
  storageWriteMetrics: string[];
  thresholds: PhaseThresholds;
}

export type ResolvedPhaseSettings =
  | { state: 'off' }
  | { state: 'invalid'; errors: string[] }
  | { state: 'on'; settings: EffectivePhaseSettings };

/** The effective settings of a cluster: off unless enabled, and never usable when invalid. */
export function resolvePhaseSettings(raw: PhaseSettings | undefined): ResolvedPhaseSettings {
  const settings = compactPhaseSettings(raw);
  if (settings?.enabled !== true) {
    return { state: 'off' };
  }
  const errors = phaseSettingsErrors(settings);
  if (errors.length > 0) {
    return { state: 'invalid', errors };
  }
  return {
    state: 'on',
    settings: {
      gpuPowerMetric: settings.gpuPowerMetric ?? PHASE_SETTING_DEFAULTS.gpuPowerMetric,
      gpuUtilizationMetric: settings.gpuUtilizationMetric ?? PHASE_SETTING_DEFAULTS.gpuUtilizationMetric,
      storageWriteMetrics: [...(settings.storageWriteMetrics ?? PHASE_SETTING_DEFAULTS.storageWriteMetrics)],
      thresholds: {
        idleGpuUtilizationPercent: settings.idleGpuUtilizationPercent ?? PHASE_SETTING_DEFAULTS.idleGpuUtilizationPercent,
        stallMinSeconds: 60 * (settings.stallMinutes ?? PHASE_SETTING_DEFAULTS.stallMinutes),
        checkpointMinWriteBytesPerSecond:
          1024 * 1024 * (settings.checkpointMinWriteMibPerSecond ?? PHASE_SETTING_DEFAULTS.checkpointMinWriteMibPerSecond),
      },
    },
  };
}
