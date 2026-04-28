import { migrateLegacyPanelKey, parseMetricKey } from '../pages/JobDashboard/scenes/metricDiscovery';
import {
  cloneMetricSifterParams,
  normalizeMetricSifterRuntimeOverrides,
  type MetricSifterRuntimeOverrides,
} from '../components/MetricSifter/params';
import type { MetricSifterParams } from '../api/types';
import { buildDashboardDestinationKey, JOB_VIEW_DESTINATION_KEY } from '../pages/JobSearch/linkedDashboard';
import type { MetricExplorerSortBy } from '../pages/JobDashboard/components/MetricExplorer';

const SEARCH_PREFERENCES_KEY = 'yuuki-slurm-app.search-preferences';
const TIMELINE_TIME_RANGE_KEY = 'yuuki-slurm-app.timeline-time-range';
const METRICSIFTER_RUNTIME_OVERRIDES_KEY = 'yuuki-slurm-app.metricsifter-runtime-overrides';
const LINKED_DASHBOARD_SELECTION_KEY = 'yuuki-slurm-app.linked-dashboard-selection';
const METRIC_EXPLORER_SORT_BY_KEY = 'yuuki-slurm-app.metric-explorer-sort-by';
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

export function loadTimelineTimeRange(): { from: string; to: string } | null {
  return safeRead<{ from: string; to: string } | null>(TIMELINE_TIME_RANGE_KEY, null);
}

export function saveTimelineTimeRange(from: string, to: string) {
  window.localStorage.setItem(TIMELINE_TIME_RANGE_KEY, JSON.stringify({ from, to }));
}

export function normalizeJobDashboardPanelSelection(metricIds: unknown[]): string[] {
  if (!Array.isArray(metricIds)) {
    return [];
  }

  const seen = new Set<string>();
  return metricIds
    .filter((item): item is string => typeof item === 'string')
    .map((item) => migrateLegacyPanelKey(item))
    .filter((item) => parseMetricKey(item) !== null)
    .filter((item) => {
      if (seen.has(item)) {
        return false;
      }
      seen.add(item);
      return true;
    });
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
  const resolvedDefaults = cloneMetricSifterParams(defaultParams);
  const rawValue = window.localStorage.getItem(METRICSIFTER_RUNTIME_OVERRIDES_KEY);
  if (!rawValue) {
    return {
      enabled: false,
      params: resolvedDefaults,
    };
  }

  return normalizeMetricSifterRuntimeOverrides(safeRead<unknown>(METRICSIFTER_RUNTIME_OVERRIDES_KEY, null), resolvedDefaults);
}

export function saveMetricSifterRuntimeOverrides(value: Partial<MetricSifterRuntimeOverrides>) {
  const normalized = normalizeMetricSifterRuntimeOverrides({
    enabled: value.enabled,
    params: value.params ?? cloneMetricSifterParams(),
  });
  window.localStorage.setItem(METRICSIFTER_RUNTIME_OVERRIDES_KEY, JSON.stringify(normalized));
}

export function loadMetricExplorerSortBy(): MetricExplorerSortBy {
  const value = safeRead<unknown>(METRIC_EXPLORER_SORT_BY_KEY, null);
  return value === 'name' || value === 'outliers' ? value : 'outliers';
}

export function saveMetricExplorerSortBy(value: MetricExplorerSortBy) {
  window.localStorage.setItem(METRIC_EXPLORER_SORT_BY_KEY, JSON.stringify(value));
}

export function loadLinkedDashboardSelection(clusterId: string): string | null {
  const selections = safeRead<Record<string, string>>(LINKED_DASHBOARD_SELECTION_KEY, {});
  const selection = selections[clusterId];
  if (typeof selection !== 'string') {
    return null;
  }

  if (selection === JOB_VIEW_DESTINATION_KEY || selection.startsWith('dashboard:')) {
    return selection;
  }

  return buildDashboardDestinationKey(selection);
}

export function saveLinkedDashboardSelection(clusterId: string, selection: string) {
  const selections = safeRead<Record<string, string>>(LINKED_DASHBOARD_SELECTION_KEY, {});
  window.localStorage.setItem(
    LINKED_DASHBOARD_SELECTION_KEY,
    JSON.stringify({
      ...selections,
      [clusterId]: selection,
    })
  );
}
