import { migrateLegacyPanelKey } from '../pages/JobDashboard/scenes/metricDiscovery';

const SEARCH_PREFERENCES_KEY = 'yuuki-slurm-app.search-preferences';
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

export function loadJobDashboardPanelSelection(clusterId: string, jobId: number | string): string[] {
  const value = safeRead<unknown[]>(jobDashboardPanelsKey(clusterId, jobId), []);
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => migrateLegacyPanelKey(item))
    .filter((item, index, items) => items.indexOf(item) === index);
}

export function saveJobDashboardPanelSelection(clusterId: string, jobId: number | string, metricIds: string[]) {
  const safeMetricIds = metricIds.filter((item): item is string => typeof item === 'string');
  window.localStorage.setItem(jobDashboardPanelsKey(clusterId, jobId), JSON.stringify(safeMetricIds));
}
