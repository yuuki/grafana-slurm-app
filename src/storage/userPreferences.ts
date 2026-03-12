import { migrateLegacyPanelKey, parseMetricKey } from '../pages/JobDashboard/scenes/metricDiscovery';
import {
  cloneMetricSifterParams,
  normalizeMetricSifterRuntimeOverrides,
  type MetricSifterRuntimeOverrides,
} from '../components/MetricSifter/params';
import type { MetricSifterParams } from '../api/types';

const SEARCH_PREFERENCES_KEY = 'yuuki-slurm-app.search-preferences';
const METRICSIFTER_RUNTIME_OVERRIDES_KEY = 'yuuki-slurm-app.metricsifter-runtime-overrides';
function jobDashboardPanelsKey(clusterId: string, jobId: number | string): string {
  return `yuuki-slurm-app.job-dashboard-panels:${clusterId}:${jobId}`;
}

function safeRead<T>(key: string, fallback: T): T {
  const value = window.localStorage.getItem(key);
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function loadSearchPreferences<T extends object>(): Partial<T> {
  return safeRead<Partial<T>>(SEARCH_PREFERENCES_KEY, {});
}

export function saveSearchPreferences<T extends object>(value: Partial<T>) {
  window.localStorage.setItem(SEARCH_PREFERENCES_KEY, JSON.stringify(value));
}

export function normalizeJobDashboardPanelSelection(metricIds: unknown[]): string[] {
  if (!Array.isArray(metricIds)) {
    return [];
  }

  return metricIds
    .filter((item): item is string => typeof item === 'string')
    .map((item) => migrateLegacyPanelKey(item))
    .filter((item) => parseMetricKey(item) !== null)
    .filter((item, index, items) => items.indexOf(item) === index);
}

export function loadJobDashboardPanelSelection(clusterId: string, jobId: number | string): string[] {
  return normalizeJobDashboardPanelSelection(safeRead<unknown[]>(jobDashboardPanelsKey(clusterId, jobId), []));
}

export function saveJobDashboardPanelSelection(clusterId: string, jobId: number | string, metricIds: string[]) {
  window.localStorage.setItem(
    jobDashboardPanelsKey(clusterId, jobId),
    JSON.stringify(normalizeJobDashboardPanelSelection(metricIds))
  );
}

export function loadMetricSifterRuntimeOverrides(defaultParams?: MetricSifterParams): MetricSifterRuntimeOverrides {
  const rawValue = window.localStorage.getItem(METRICSIFTER_RUNTIME_OVERRIDES_KEY);
  if (!rawValue) {
    return {
      enabled: false,
      params: cloneMetricSifterParams(defaultParams),
    };
  }

  return normalizeMetricSifterRuntimeOverrides(safeRead<unknown>(METRICSIFTER_RUNTIME_OVERRIDES_KEY, null));
}

export function saveMetricSifterRuntimeOverrides(value: Partial<MetricSifterRuntimeOverrides>) {
  const normalized = normalizeMetricSifterRuntimeOverrides({
    enabled: value.enabled,
    params: value.params ?? cloneMetricSifterParams(),
  });
  window.localStorage.setItem(METRICSIFTER_RUNTIME_OVERRIDES_KEY, JSON.stringify(normalized));
}
