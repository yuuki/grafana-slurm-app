import { ClusterSummary, JobRecord } from '../../../api/types';

export function buildInstanceMatcher(
  nodes: string[],
  instanceLabel: string,
  port: string,
  mode: 'host:port' | 'hostname'
): string {
  const joined = nodes.length > 0 ? nodes.join('|') : '__no_nodes__';
  if (mode === 'hostname') {
    return `${instanceLabel}=~"(${joined})"`;
  }
  return `${instanceLabel}=~"(${joined}):${port}"`;
}

function escapePromLabelValue(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export function buildFilterMatcher(label: string, value: string): string {
  if (!label || !value) {
    return '';
  }
  return `${label}="${escapePromLabelValue(value)}"`;
}

export function getJobTimeSettings(job: JobRecord): {
  from: string;
  to: string;
  refreshIntervals: string[];
} {
  return {
    from: new Date(job.startTime * 1000).toISOString(),
    to: job.endTime > 0 ? new Date(job.endTime * 1000).toISOString() : 'now',
    refreshIntervals: job.endTime > 0 ? [] : ['10s', '30s', '1m', '5m'],
  };
}

export function buildInstanceValues(
  nodes: string[],
  port: string,
  mode: 'host:port' | 'hostname'
): string[] {
  if (nodes.length === 0) {
    return [];
  }
  return nodes.map((node) => (mode === 'hostname' ? node : `${node}:${port}`));
}

export function buildExternalDashboardUrl(
  dashboardUrl: string,
  job: JobRecord,
  cluster: ClusterSummary
): string {
  const params = new URLSearchParams();
  params.set('from', String(job.startTime * 1000));
  params.set('to', job.endTime > 0 ? String(job.endTime * 1000) : 'now');

  const instances = buildInstanceValues(job.nodes, cluster.nodeExporterPort, cluster.nodeMatcherMode);
  for (const instance of instances) {
    params.append('var-instance', instance);
  }

  return `${dashboardUrl}?${params.toString()}`;
}
