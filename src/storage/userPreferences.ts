import { JobRecord } from '../api/types';

const SEARCH_PREFERENCES_KEY = 'yuuki-slurm-app.search-preferences';
const RECENT_JOBS_KEY = 'yuuki-slurm-app.recent-jobs';
const RECENT_JOB_LIMIT = 5;

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

export function loadRecentJobs(): JobRecord[] {
  return safeRead<JobRecord[]>(RECENT_JOBS_KEY, []);
}

export function pushRecentJob(job: JobRecord) {
  const current = loadRecentJobs().filter((item) => !(item.clusterId === job.clusterId && item.jobId === job.jobId));
  const next = [job, ...current].slice(0, RECENT_JOB_LIMIT);
  window.localStorage.setItem(RECENT_JOBS_KEY, JSON.stringify(next));
}
