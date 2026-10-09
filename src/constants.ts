export const PLUGIN_ID = 'yuuki-slurm-app';
export const PLUGIN_BASE_URL = `/a/${PLUGIN_ID}`;
export const ROUTES = {
  Jobs: 'jobs',
  Compare: 'compare',
} as const;

export function buildJobRoute(clusterId: string, jobId: string | number): string {
  return `${PLUGIN_BASE_URL}/${ROUTES.Jobs}/${clusterId}/${jobId}`;
}

export function buildCompareRoute(params?: URLSearchParams): string {
  const query = params?.toString();
  return `${PLUGIN_BASE_URL}/${ROUTES.Compare}${query ? `?${query}` : ''}`;
}
