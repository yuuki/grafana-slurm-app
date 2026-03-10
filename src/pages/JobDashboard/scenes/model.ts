import { JobRecord } from '../../../api/types';

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

export function buildFilterMatcher(label: string, value: string): string {
  if (!label || !value) {
    return '';
  }
  return `${label}="${value}"`;
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
