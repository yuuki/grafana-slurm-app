import { dateMath, FieldConfigSource, ThresholdsMode } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import { ClusterSummary, JobRecord } from '../../../api/types';
import { buildFilterMatcher, buildInstanceMatcher } from './model';

export type MetricMatcherKind = 'gpu' | 'node';
type MetricFieldConfig = Pick<FieldConfigSource, 'defaults' | 'overrides'>;

export interface MetricExplorerEntry {
  kind: 'raw';
  key: string;
  matcherKind: MetricMatcherKind;
  title: string;
  description: string;
  legendFormat: string;
  fieldConfig: MetricFieldConfig;
  metricName?: string;
  labelKeys: string[];
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

const LEGACY_PANEL_KEY_MIGRATIONS: Record<string, string> = {
  'gpu-utilization': buildRawMetricKey('gpu', 'DCGM_FI_DEV_GPU_UTIL'),
  'gpu-memory-used': buildRawMetricKey('gpu', 'DCGM_FI_DEV_FB_USED'),
  'gpu-temperature': buildRawMetricKey('gpu', 'DCGM_FI_DEV_GPU_TEMP'),
  'gpu-power-usage': buildRawMetricKey('gpu', 'DCGM_FI_DEV_POWER_USAGE'),
  'sm-clock': buildRawMetricKey('gpu', 'DCGM_FI_DEV_SM_CLOCK'),
  'nvlink-bandwidth': buildRawMetricKey('gpu', 'DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL'),
  'load-average-15m': buildRawMetricKey('node', 'node_load15'),
};

const rawPresentationMap = new Map(
  RAW_METRIC_PRESENTATIONS.map((definition) => [definition.metricName, definition] as const)
);

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
  return [entry.metricName && hasKnownPresentation(entry.metricName) ? 0 : 1, entry.title.toLowerCase()];
}

export function buildRawMetricKey(matcherKind: MetricMatcherKind, metricName: string): string {
  return `raw:${matcherKind}:${metricName}`;
}

export function parseMetricKey(metricKey: string):
  | { kind: 'raw'; matcherKind: MetricMatcherKind; metricName: string }
  | null {
  if (metricKey.startsWith('raw:gpu:')) {
    return { kind: 'raw', matcherKind: 'gpu', metricName: metricKey.slice('raw:gpu:'.length) };
  }
  if (metricKey.startsWith('raw:node:')) {
    return { kind: 'raw', matcherKind: 'node', metricName: metricKey.slice('raw:node:'.length) };
  }
  return null;
}

export function migrateLegacyPanelKey(metricId: string): string {
  if (metricId.startsWith('raw:')) {
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

export function getMetricEntryByKey(metricKey: string): (MetricExplorerEntry & {
  buildExpr: (matcher: string, instanceLabel: string) => string;
}) | undefined {
  const parsed = parseMetricKey(metricKey);
  if (!parsed) {
    return undefined;
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
}): Promise<MetricExplorerEntry[]> {
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

  return buildMetricExplorerEntries({ nodeSeries, gpuSeries });
}
