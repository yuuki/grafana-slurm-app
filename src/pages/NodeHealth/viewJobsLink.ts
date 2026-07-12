import { PLUGIN_ID } from '../../constants';

export function buildViewJobsUrl(clusterId: string, node: string, fromMs: number, toMs: number): string {
  const params = new URLSearchParams();
  params.set('cluster', clusterId);
  params.set('node_names', node);
  params.set('from', new Date(fromMs).toISOString());
  params.set('to', new Date(toMs).toISOString());
  return `/a/${PLUGIN_ID}/jobs?${params.toString()}`;
}
