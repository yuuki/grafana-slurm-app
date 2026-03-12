import { dateMath, FieldConfigSource, ThresholdsMode } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import { ClusterSummary, JobRecord } from '../../../api/types';
import { buildFilterMatcher, buildInstanceMatcher } from './model';

export type MetricMatcherKind = 'gpu' | 'node';
type MetricEntryKind = 'raw' | 'view';

type MetricFieldConfig = Pick<FieldConfigSource, 'defaults' | 'overrides'>;

export interface MetricExplorerEntry {
  kind: MetricEntryKind;
  key: string;
  matcherKind: MetricMatcherKind;
  title: string;
  description: string;
  legendFormat: string;
  fieldConfig: MetricFieldConfig;
  metricName?: string;
  viewId?: string;
  labelKeys: string[];
}

interface RecommendedMetricViewDefinition {
  id: string;
  title: string;
  description: string;
  matcherKind: MetricMatcherKind;
  legendFormat: string;
  fieldConfig: MetricFieldConfig;
  buildExpr: (matcher: string, instanceLabel: string) => string;
}

interface RawMetricPresentation {
  metricName: string;
  matcherKind: MetricMatcherKind;
  title: string;
  description: string;
  legendFormat: string;
  fieldConfig: MetricFieldConfig;
}

type PromSeries = Record<string, string>;

const DEFAULT_FIELD_CONFIG: MetricFieldConfig = { defaults: {}, overrides: [] };

const RAW_METRIC_PRESENTATIONS: RawMetricPresentation[] = [
  {
    metricName: 'DCGM_FI_DEV_GPU_UTIL',
    matcherKind: 'gpu',
    title: 'GPU Utilization',
    description: 'Per-GPU utilization by node.',
    legendFormat: '{{instance}} / GPU {{gpu}}',
    fieldConfig: { defaults: { unit: 'percent', min: 0, max: 100 }, overrides: [] },
  },
  {
    metricName: 'DCGM_FI_DEV_FB_USED',
    matcherKind: 'gpu',
    title: 'GPU Memory Used',
    description: 'Framebuffer memory used per GPU.',
    legendFormat: '{{instance}} / GPU {{gpu}}',
    fieldConfig: { defaults: { unit: 'decmbytes' }, overrides: [] },
  },
  {
    metricName: 'DCGM_FI_DEV_GPU_TEMP',
    matcherKind: 'gpu',
    title: 'GPU Temperature',
    description: 'Temperature trend per GPU.',
    legendFormat: '{{instance}} / GPU {{gpu}}',
    fieldConfig: {
      defaults: {
        unit: 'celsius',
        thresholds: {
          mode: ThresholdsMode.Absolute,
          steps: [
            { color: 'green', value: -Infinity },
            { color: 'orange', value: 75 },
            { color: 'red', value: 85 },
          ],
        },
      },
      overrides: [],
    },
  },
  {
    metricName: 'DCGM_FI_DEV_POWER_USAGE',
    matcherKind: 'gpu',
    title: 'GPU Power Usage',
    description: 'Power draw per GPU.',
    legendFormat: '{{instance}} / GPU {{gpu}}',
    fieldConfig: { defaults: { unit: 'watt' }, overrides: [] },
  },
  {
    metricName: 'DCGM_FI_DEV_SM_CLOCK',
    matcherKind: 'gpu',
    title: 'SM Clock',
    description: 'Streaming multiprocessor clock frequency.',
    legendFormat: '{{instance}} / GPU {{gpu}}',
    fieldConfig: { defaults: { unit: 'hertz' }, overrides: [] },
  },
  {
    metricName: 'DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL',
    matcherKind: 'gpu',
    title: 'NVLink Bandwidth',
    description: 'Total NVLink bandwidth across devices.',
    legendFormat: '{{instance}} / GPU {{gpu}}',
    fieldConfig: { defaults: { unit: 'Bps' }, overrides: [] },
  },
  {
    metricName: 'node_load15',
    matcherKind: 'node',
    title: 'Load Average (15m)',
    description: 'Node load average over 15 minutes.',
    legendFormat: '{{instance}}',
    fieldConfig: DEFAULT_FIELD_CONFIG,
  },
];

const RECOMMENDED_VIEWS: RecommendedMetricViewDefinition[] = [
  {
    id: 'cpu-utilization',
    title: 'CPU Utilization',
    description: 'Average CPU utilization per node.',
    matcherKind: 'node',
    legendFormat: '{{instance}}',
    fieldConfig: { defaults: { unit: 'percent', min: 0, max: 100 }, overrides: [] },
    buildExpr: (matcher, instanceLabel) =>
      `100 - (avg by(${instanceLabel})(rate(node_cpu_seconds_total{mode="idle",${matcher}}[5m])) * 100)`,
  },
  {
    id: 'memory-usage',
    title: 'Memory Usage',
    description: 'Used system memory per node.',
    matcherKind: 'node',
    legendFormat: '{{instance}}',
    fieldConfig: { defaults: { unit: 'bytes' }, overrides: [] },
    buildExpr: (matcher) => `node_memory_MemTotal_bytes{${matcher}} - node_memory_MemAvailable_bytes{${matcher}}`,
  },
  {
    id: 'memory-utilization',
    title: 'Memory Utilization %',
    description: 'Memory usage ratio per node.',
    matcherKind: 'node',
    legendFormat: '{{instance}}',
    fieldConfig: { defaults: { unit: 'percent', min: 0, max: 100 }, overrides: [] },
    buildExpr: (matcher) =>
      `100 * (1 - node_memory_MemAvailable_bytes{${matcher}} / node_memory_MemTotal_bytes{${matcher}})`,
  },
  {
    id: 'network-receive',
    title: 'Network Receive',
    description: 'Ingress throughput by node and device.',
    matcherKind: 'node',
    legendFormat: '{{instance}} {{device}}',
    fieldConfig: { defaults: { unit: 'Bps' }, overrides: [] },
    buildExpr: (matcher) => `rate(node_network_receive_bytes_total{device!="lo",${matcher}}[5m])`,
  },
  {
    id: 'network-transmit',
    title: 'Network Transmit',
    description: 'Egress throughput by node and device.',
    matcherKind: 'node',
    legendFormat: '{{instance}} {{device}}',
    fieldConfig: { defaults: { unit: 'Bps' }, overrides: [] },
    buildExpr: (matcher) => `rate(node_network_transmit_bytes_total{device!="lo",${matcher}}[5m])`,
  },
  {
    id: 'infiniband-receive',
    title: 'InfiniBand Receive',
    description: 'InfiniBand ingress throughput.',
    matcherKind: 'node',
    legendFormat: '{{instance}} {{device}}',
    fieldConfig: { defaults: { unit: 'Bps' }, overrides: [] },
    buildExpr: (matcher) => `rate(node_infiniband_port_data_received_bytes_total{${matcher}}[5m])`,
  },
  {
    id: 'infiniband-transmit',
    title: 'InfiniBand Transmit',
    description: 'InfiniBand egress throughput.',
    matcherKind: 'node',
    legendFormat: '{{instance}} {{device}}',
    fieldConfig: { defaults: { unit: 'Bps' }, overrides: [] },
    buildExpr: (matcher) => `rate(node_infiniband_port_data_transmitted_bytes_total{${matcher}}[5m])`,
  },
  {
    id: 'disk-read',
    title: 'Disk Read',
    description: 'Disk read throughput by node and device.',
    matcherKind: 'node',
    legendFormat: '{{instance}} {{device}}',
    fieldConfig: { defaults: { unit: 'Bps' }, overrides: [] },
    buildExpr: (matcher) => `rate(node_disk_read_bytes_total{${matcher}}[5m])`,
  },
  {
    id: 'disk-write',
    title: 'Disk Write',
    description: 'Disk write throughput by node and device.',
    matcherKind: 'node',
    legendFormat: '{{instance}} {{device}}',
    fieldConfig: { defaults: { unit: 'Bps' }, overrides: [] },
    buildExpr: (matcher) => `rate(node_disk_written_bytes_total{${matcher}}[5m])`,
  },
  {
    id: 'disk-read-iops',
    title: 'Disk Read IOPS',
    description: 'Read IOPS by node and device.',
    matcherKind: 'node',
    legendFormat: '{{instance}} {{device}}',
    fieldConfig: { defaults: { unit: 'iops' }, overrides: [] },
    buildExpr: (matcher) => `rate(node_disk_reads_completed_total{${matcher}}[5m])`,
  },
  {
    id: 'disk-write-iops',
    title: 'Disk Write IOPS',
    description: 'Write IOPS by node and device.',
    matcherKind: 'node',
    legendFormat: '{{instance}} {{device}}',
    fieldConfig: { defaults: { unit: 'iops' }, overrides: [] },
    buildExpr: (matcher) => `rate(node_disk_writes_completed_total{${matcher}}[5m])`,
  },
];

const LEGACY_PANEL_KEY_MIGRATIONS: Record<string, string> = {
  'gpu-utilization': buildRawMetricKey('gpu', 'DCGM_FI_DEV_GPU_UTIL'),
  'gpu-memory-used': buildRawMetricKey('gpu', 'DCGM_FI_DEV_FB_USED'),
  'gpu-temperature': buildRawMetricKey('gpu', 'DCGM_FI_DEV_GPU_TEMP'),
  'gpu-power-usage': buildRawMetricKey('gpu', 'DCGM_FI_DEV_POWER_USAGE'),
  'sm-clock': buildRawMetricKey('gpu', 'DCGM_FI_DEV_SM_CLOCK'),
  'nvlink-bandwidth': buildRawMetricKey('gpu', 'DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL'),
  'load-average-15m': buildRawMetricKey('node', 'node_load15'),
  'cpu-utilization': buildRecommendedMetricKey('cpu-utilization'),
  'memory-usage': buildRecommendedMetricKey('memory-usage'),
  'memory-utilization': buildRecommendedMetricKey('memory-utilization'),
  'network-receive': buildRecommendedMetricKey('network-receive'),
  'network-transmit': buildRecommendedMetricKey('network-transmit'),
  'infiniband-receive': buildRecommendedMetricKey('infiniband-receive'),
  'infiniband-transmit': buildRecommendedMetricKey('infiniband-transmit'),
  'disk-read': buildRecommendedMetricKey('disk-read'),
  'disk-write': buildRecommendedMetricKey('disk-write'),
  'disk-read-iops': buildRecommendedMetricKey('disk-read-iops'),
  'disk-write-iops': buildRecommendedMetricKey('disk-write-iops'),
};

const rawPresentationMap = new Map(
  RAW_METRIC_PRESENTATIONS.map((definition) => [definition.metricName, definition] as const)
);
const recommendedViewMap = new Map(RECOMMENDED_VIEWS.map((definition) => [definition.id, definition] as const));

function defaultLegendFormat(labelKeys: string[]): string {
  if (labelKeys.includes('gpu')) {
    return '{{instance}} / GPU {{gpu}}';
  }
  if (labelKeys.includes('device')) {
    return '{{instance}} {{device}}';
  }
  return '{{instance}}';
}

function hasKnownPresentation(metricName: string): boolean {
  return rawPresentationMap.has(metricName);
}

function dedupe<T>(items: T[]): T[] {
  return items.filter((item, index) => items.indexOf(item) === index);
}

function buildRawMetricEntry(matcherKind: MetricMatcherKind, metricName: string, labelKeys: string[]): MetricExplorerEntry {
  const presentation = rawPresentationMap.get(metricName);

  return {
    kind: 'raw',
    key: buildRawMetricKey(matcherKind, metricName),
    matcherKind,
    title: presentation?.title ?? metricName,
    description: presentation?.description ?? '',
    legendFormat: presentation?.legendFormat ?? defaultLegendFormat(labelKeys),
    fieldConfig: presentation?.fieldConfig ?? DEFAULT_FIELD_CONFIG,
    metricName,
    labelKeys,
  };
}

function entrySortKey(entry: MetricExplorerEntry): [number, string] {
  return [entry.kind === 'raw' && entry.metricName && hasKnownPresentation(entry.metricName) ? 0 : 1, entry.title.toLowerCase()];
}

export function buildRawMetricKey(matcherKind: MetricMatcherKind, metricName: string): string {
  return `raw:${matcherKind}:${metricName}`;
}

export function buildRecommendedMetricKey(viewId: string): string {
  return `view:${viewId}`;
}

export function parseMetricKey(metricKey: string):
  | { kind: 'raw'; matcherKind: MetricMatcherKind; metricName: string }
  | { kind: 'view'; viewId: string }
  | null {
  if (metricKey.startsWith('raw:gpu:')) {
    return { kind: 'raw', matcherKind: 'gpu', metricName: metricKey.slice('raw:gpu:'.length) };
  }
  if (metricKey.startsWith('raw:node:')) {
    return { kind: 'raw', matcherKind: 'node', metricName: metricKey.slice('raw:node:'.length) };
  }
  if (metricKey.startsWith('view:')) {
    return { kind: 'view', viewId: metricKey.slice('view:'.length) };
  }
  return null;
}

export function migrateLegacyPanelKey(metricId: string): string {
  if (metricId.startsWith('raw:') || metricId.startsWith('view:')) {
    return metricId;
  }
  return LEGACY_PANEL_KEY_MIGRATIONS[metricId] ?? metricId;
}

export function buildMetricExplorerEntries({
  nodeSeries,
  gpuSeries,
}: {
  nodeSeries: PromSeries[];
  gpuSeries: PromSeries[];
}): MetricExplorerEntry[] {
  const entries = new Map<string, MetricExplorerEntry>();

  const append = (matcherKind: MetricMatcherKind, seriesList: PromSeries[]) => {
    for (const series of seriesList) {
      const metricName = series.__name__;
      if (!metricName) {
        continue;
      }

      const labelKeys = dedupe(Object.keys(series).filter((key) => key !== '__name__')).sort();
      const entry = buildRawMetricEntry(matcherKind, metricName, labelKeys);
      entries.set(entry.key, entry);
    }
  };

  append('node', nodeSeries);
  append('gpu', gpuSeries);

  return [...entries.values()].sort((left, right) => {
    const [leftRank, leftTitle] = entrySortKey(left);
    const [rightRank, rightTitle] = entrySortKey(right);
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    return leftTitle.localeCompare(rightTitle);
  });
}

export function getRecommendedMetricEntries(): MetricExplorerEntry[] {
  return RECOMMENDED_VIEWS.map((definition) => ({
    kind: 'view',
    key: buildRecommendedMetricKey(definition.id),
    matcherKind: definition.matcherKind,
    title: definition.title,
    description: definition.description,
    legendFormat: definition.legendFormat,
    fieldConfig: definition.fieldConfig,
    viewId: definition.id,
    labelKeys: [],
  }));
}

export function getMetricEntryByKey(metricKey: string): (MetricExplorerEntry & {
  buildExpr: (matcher: string, instanceLabel: string) => string;
}) | undefined {
  const parsed = parseMetricKey(metricKey);
  if (!parsed) {
    return undefined;
  }

  if (parsed.kind === 'view') {
    const definition = recommendedViewMap.get(parsed.viewId);
    if (!definition) {
      return undefined;
    }
    return {
      kind: 'view',
      key: metricKey,
      matcherKind: definition.matcherKind,
      title: definition.title,
      description: definition.description,
      legendFormat: definition.legendFormat,
      fieldConfig: definition.fieldConfig,
      viewId: definition.id,
      labelKeys: [],
      buildExpr: definition.buildExpr,
    };
  }

  const presentation = rawPresentationMap.get(parsed.metricName);
  const labelKeys = presentation?.legendFormat.includes('{{gpu}}')
    ? ['instance', 'gpu']
    : presentation?.legendFormat.includes('{{device}}')
      ? ['instance', 'device']
      : ['instance'];
  const entry = buildRawMetricEntry(parsed.matcherKind, parsed.metricName, labelKeys);
  return {
    ...entry,
    buildExpr: (matcher) => `${parsed.metricName}{${matcher}}`,
  };
}

function normalizePrometheusTime(value: string, roundUp: boolean): string {
  const parsed = dateMath.toDateTime(value, { now: new Date(), roundUp });
  return parsed?.toISOString() ?? value;
}

async function querySeriesFromDatasource({
  datasourceUid,
  matcher,
  from,
  to,
}: {
  datasourceUid: string;
  matcher: string;
  from: string;
  to: string;
}): Promise<PromSeries[]> {
  const response = await getBackendSrv().get<{ data?: PromSeries[] }>(
    `/api/datasources/proxy/uid/${datasourceUid}/api/v1/series`,
    {
      'match[]': matcher,
      start: from,
      end: to,
    }
  );

  return Array.isArray(response?.data) ? response.data : [];
}

export async function discoverJobMetrics({
  job,
  cluster,
  timeRange,
  querySeries = querySeriesFromDatasource,
}: {
  job: JobRecord;
  cluster: ClusterSummary;
  timeRange: { from: string; to: string };
  querySeries?: (args: { datasourceUid: string; matcher: string; from: string; to: string }) => Promise<PromSeries[]>;
}): Promise<{
  entries: MetricExplorerEntry[];
  recommended: MetricExplorerEntry[];
}> {
  const normalizedTimeRange = {
    from: normalizePrometheusTime(timeRange.from, false),
    to: normalizePrometheusTime(timeRange.to, true),
  };
  const filterMatcher = buildFilterMatcher(cluster.metricsFilterLabel, cluster.metricsFilterValue);
  const filterSuffix = filterMatcher ? `,${filterMatcher}` : '';
  const nodeMatcher = `{${buildInstanceMatcher(job.nodes, cluster.instanceLabel, cluster.nodeExporterPort, cluster.nodeMatcherMode)}${filterSuffix}}`;
  const gpuMatcher = `{${buildInstanceMatcher(job.nodes, cluster.instanceLabel, cluster.dcgmExporterPort, cluster.nodeMatcherMode)}${filterSuffix}}`;

  const [nodeSeries, gpuSeries] = await Promise.all([
    querySeries({
      datasourceUid: cluster.metricsDatasourceUid,
      matcher: nodeMatcher,
      from: normalizedTimeRange.from,
      to: normalizedTimeRange.to,
    }),
    querySeries({
      datasourceUid: cluster.metricsDatasourceUid,
      matcher: gpuMatcher,
      from: normalizedTimeRange.from,
      to: normalizedTimeRange.to,
    }),
  ]);

  return {
    entries: buildMetricExplorerEntries({ nodeSeries, gpuSeries }),
    recommended: getRecommendedMetricEntries(),
  };
}
