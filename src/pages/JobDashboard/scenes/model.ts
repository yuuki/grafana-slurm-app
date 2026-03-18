import { dateMath } from '@grafana/data';
import { JobRecord } from '../../../api/types';

export type MetricsQueryType = 'prometheus' | 'victoriametrics';

export function escapePromRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

function escapePromQuotedIdentifier(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function formatPromLabelName(label: string): string {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(label) ? label : `"${escapePromQuotedIdentifier(label)}"`;
}

export function buildInstanceMatcher(
  nodes: string[],
  instanceLabel: string,
  mode: 'host:port' | 'hostname',
  metricsType: MetricsQueryType = 'prometheus'
): string {
  const label = formatLabelNameForDatasource(instanceLabel, metricsType);
  const joined = nodes.length > 0 ? nodes.map((node) => escapePromRegex(node)).join('|') : '__no_nodes__';
  if (mode === 'hostname') {
    return `${label}=~"(${joined})"`;
  }
  return `${label}=~"(${joined}):[0-9]+"`;
}

function escapePromLabelValue(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export function buildFilterMatcher(
  label: string,
  value: string,
  metricsType: MetricsQueryType = 'prometheus'
): string {
  if (!label || !value) {
    return '';
  }
  return `${formatLabelNameForDatasource(label, metricsType)}="${escapePromLabelValue(value)}"`;
}

export function formatLabelNameForDatasource(
  label: string,
  metricsType: MetricsQueryType = 'prometheus'
): string {
  if (metricsType === 'victoriametrics') {
    return label;
  }
  return formatPromLabelName(label);
}

export function normalizePrometheusTime(value: string, roundUp: boolean): string {
  const parsed = dateMath.toDateTime(value, { now: new Date(), roundUp });
  return parsed?.toISOString() ?? value;
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
