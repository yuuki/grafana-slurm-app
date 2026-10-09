import { SelectableValue } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import { ClusterSummary } from '../../api/types';
import {
  buildRawMetricKey,
  getMetricEntryByKey,
  inferMetricTypeFromName,
  MetricExplorerEntry,
  PrometheusMetricType,
  queryMetadataFromDatasource,
} from '../JobDashboard/scenes/metricDiscovery';
import { buildFilterMatcher } from '../JobDashboard/scenes/model';
import { isValidMetricName } from './model';

export const SUGGESTED_METRICS: string[] = [
  'DCGM_FI_PROF_PIPE_TENSOR_ACTIVE',
  'DCGM_FI_PROF_SM_ACTIVE',
  'DCGM_FI_PROF_DRAM_ACTIVE',
  'DCGM_FI_DEV_GPU_UTIL',
  'DCGM_FI_DEV_FB_USED',
  'DCGM_FI_DEV_POWER_USAGE',
  'DCGM_FI_DEV_GPU_TEMP',
  'DCGM_FI_PROF_NVLINK_TX_BYTES',
  'DCGM_FI_PROF_NVLINK_RX_BYTES',
  'node_load1',
  'node_network_receive_bytes_total',
  'node_infiniband_port_data_received_bytes_total',
];

export function isGpuMetric(name: string): boolean {
  return name.startsWith('DCGM_');
}

export async function listMetricNames(cluster: ClusterSummary, range: { from: number; to: number }): Promise<string[]> {
  if (!cluster.metricsDatasourceUid) {
    return [];
  }
  const params = new URLSearchParams();
  const filter = buildFilterMatcher(cluster.metricsFilterLabel, cluster.metricsFilterValue, cluster.metricsType);
  if (filter) {
    params.append('match[]', `{${filter}}`);
  }
  params.set('start', String(range.from));
  params.set('end', String(range.to));
  const response = await getBackendSrv().get<{ data?: string[] }>(
    `/api/datasources/proxy/uid/${cluster.metricsDatasourceUid}/api/v1/label/__name__/values?${params.toString()}`
  );
  return (response?.data ?? []).filter(isValidMetricName).sort();
}

export async function fetchMetricTypes(cluster: ClusterSummary): Promise<Map<string, PrometheusMetricType>> {
  if (!cluster.metricsDatasourceUid) {
    return new Map();
  }
  try {
    return await queryMetadataFromDatasource({ datasourceUid: cluster.metricsDatasourceUid });
  } catch {
    return new Map();
  }
}

export function resolveMetricType(name: string, types: Map<string, PrometheusMetricType>): PrometheusMetricType {
  const known = types.get(name);
  return known && known !== 'unknown' ? known : inferMetricTypeFromName(name);
}

function toOption(name: string): SelectableValue<string> {
  return { label: name, value: name };
}

export function buildMetricOptions(names: string[]): Array<SelectableValue<string>> {
  const available = new Set(names);
  const suggested = SUGGESTED_METRICS.filter((name) => available.has(name));
  const suggestedSet = new Set(suggested);
  const others = names.filter((name) => !suggestedSet.has(name));
  const groups: Array<SelectableValue<string>> = [];
  if (suggested.length > 0) {
    groups.push({ label: 'Suggested', options: suggested.map(toOption) });
  }
  groups.push({ label: 'All metrics', options: others.map(toOption) });
  return groups;
}

export function buildCompareMetricEntry(metricName: string, metricType: PrometheusMetricType): MetricExplorerEntry {
  const base = getMetricEntryByKey(buildRawMetricKey(metricName))!;
  const gpu = isGpuMetric(metricName);
  return {
    ...base,
    metricType,
    labelKeys: gpu ? ['gpu', 'instance'] : ['instance'],
    legendFormat: gpu ? '{{instance}} / GPU {{gpu}}' : '{{instance}}',
  };
}
