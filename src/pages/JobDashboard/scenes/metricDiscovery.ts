import { dateMath, FieldConfigSource, ThresholdsMode } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import { ClusterSummary, JobRecord } from '../../../api/types';
import { buildFilterMatcher, formatLabelNameForDatasource } from './model';

export type MetricMatcherKind = 'gpu' | 'node';
type MetricFieldConfig = Pick<FieldConfigSource, 'defaults' | 'overrides'>;

export interface MetricExplorerEntry {
  kind: 'raw';
  key: string;
  matcherKind: MetricMatcherKind;
  title: string;
  description: string;
  legendFormat: string;
  rawLegendFormat: string;
  aggregatedLegendFormat: string;
  aggregationEligible: boolean;
  aggregationLabel?: string;
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
type DiscoveryTarget = 'node' | 'gpu';
type DiscoveryQueryArgs = { target: DiscoveryTarget; datasourceUid: string; matcher: string; from: string; to: string };
type DiscoveryFallbackArgs = { target: DiscoveryTarget; probe: string; datasourceUid: string; expr: string; time: string };
type DiscoveryFallbackFailure = DiscoveryFallbackArgs & { errorStatus?: number; errorMessage?: string; errorData?: unknown };

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

function resolveAggregationLabel(
  matcherKind: MetricMatcherKind,
  labelKeys: string[],
  aggregationNodeLabels: string[]
): string | undefined {
  if (matcherKind !== 'gpu') {
    return undefined;
  }

  return aggregationNodeLabels.find((label) => labelKeys.includes(label));
}

function buildRawMetricEntry(
  matcherKind: MetricMatcherKind,
  metricName: string,
  labelKeys: string[],
  aggregationNodeLabels: string[]
): MetricExplorerEntry {
  const presentation = rawPresentationMap.get(metricName);
  const rawLegend = presentation?.legendFormat ?? defaultLegendFormat(labelKeys);
  const aggregationLabel = resolveAggregationLabel(matcherKind, labelKeys, aggregationNodeLabels);
  const aggregationEligible = Boolean(aggregationLabel);

  return {
    kind: 'raw',
    key: buildRawMetricKey(matcherKind, metricName),
    matcherKind,
    title: presentation?.title ?? metricName,
    description: presentation?.description ?? '',
    legendFormat: rawLegend,
    rawLegendFormat: rawLegend,
    aggregatedLegendFormat: aggregationEligible ? `{{${aggregationLabel}}}` : rawLegend,
    aggregationEligible,
    aggregationLabel,
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
  aggregationNodeLabels,
}: {
  nodeSeries: PromSeries[];
  gpuSeries: PromSeries[];
  aggregationNodeLabels: string[];
}): MetricExplorerEntry[] {
  const entries = new Map<string, MetricExplorerEntry>();

  const append = (matcherKind: MetricMatcherKind, seriesList: PromSeries[]) => {
    for (const series of seriesList) {
      const metricName = series.__name__;
      if (!metricName) {
        continue;
      }

      const labelKeys = dedupe(Object.keys(series).filter((key) => key !== '__name__')).sort();
      const entry = buildRawMetricEntry(matcherKind, metricName, labelKeys, aggregationNodeLabels);
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
  const entry = buildRawMetricEntry(parsed.matcherKind, parsed.metricName, labelKeys, []);
  return {
    ...entry,
    buildExpr: (matcher) => `${parsed.metricName}{${matcher}}`,
  };
}

function normalizePrometheusTime(value: string, roundUp: boolean): string {
  const parsed = dateMath.toDateTime(value, { now: new Date(), roundUp });
  return parsed?.toISOString() ?? value;
}

function buildDiscoveryNodeValue(node: string | undefined, port: string, mode: ClusterSummary['nodeMatcherMode']): string {
  const resolvedNode = node ?? '__no_nodes__';
  if (mode === 'hostname') {
    return resolvedNode;
  }
  return `${resolvedNode}:${port}`;
}

function buildDiscoveryMatcher({
  node,
  instanceLabel,
  port,
  mode,
  metricsType,
  filterMatcher,
}: {
  node: string | undefined;
  instanceLabel: string;
  port: string;
  mode: ClusterSummary['nodeMatcherMode'];
  metricsType: ClusterSummary['metricsType'];
  filterMatcher: string;
}): string {
  const exactInstanceMatcher = buildFilterMatcher(instanceLabel, buildDiscoveryNodeValue(node, port, mode), metricsType);
  const filterSuffix = filterMatcher ? `,${filterMatcher}` : '';
  return `{${exactInstanceMatcher}${filterSuffix}}`;
}

async function querySeriesFromDatasource({
  datasourceUid,
  matcher,
  from,
  to,
}: DiscoveryQueryArgs): Promise<PromSeries[]> {
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

function buildDiscoveryFallbackLabelNames(
  aggregationNodeLabels: string[],
  metricsType: ClusterSummary['metricsType']
): string[] {
  return dedupe(['__name__', 'instance', 'gpu', 'device', ...aggregationNodeLabels]).map((label) =>
    formatLabelNameForDatasource(label, metricsType)
  );
}

function buildDiscoveryFallbackArgs(
  matcher: string,
  aggregationNodeLabels: string[],
  metricsType: ClusterSummary['metricsType'],
  datasourceUid: string,
  target: DiscoveryTarget,
  time: string
): DiscoveryFallbackArgs[] {
  const labelNames = buildDiscoveryFallbackLabelNames(aggregationNodeLabels, metricsType);
  const byClause = labelNames.join(',');

  return [
    {
      target,
      probe: 'count_by_selector',
      datasourceUid,
      expr: `count by(${byClause}) (${matcher})`,
      time,
    },
    {
      target,
      probe: 'count_by_last_over_time',
      datasourceUid,
      expr: `count by(${byClause}) (last_over_time(${matcher}[5m]))`,
      time,
    },
    {
      target,
      probe: 'last_over_time',
      datasourceUid,
      expr: `last_over_time(${matcher}[5m])`,
      time,
    },
    {
      target,
      probe: 'group_by_last_over_time',
      datasourceUid,
      expr: `group by(${byClause}) (last_over_time(${matcher}[5m]))`,
      time,
    },
  ];
}

async function queryInstantFromDatasource({
  datasourceUid,
  expr,
  time,
}: DiscoveryFallbackArgs): Promise<PromSeries[]> {
  const response = await getBackendSrv().get<{ data?: { result?: Array<{ metric?: PromSeries }> } }>(
    `/api/datasources/proxy/uid/${datasourceUid}/api/v1/query`,
    {
      query: expr,
      time,
    }
  );

  return Array.isArray(response?.data?.result)
    ? response.data.result.map((item) => item.metric ?? {}).filter((metric) => metric.__name__)
    : [];
}

function isSeriesQueryUnsupported(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && (error as { status?: number }).status === 422;
}

function getErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  if ('status' in error) {
    return (error as { status?: number }).status;
  }
  if ('errorStatus' in error) {
    return (error as { errorStatus?: number }).errorStatus;
  }
  return undefined;
}

function getErrorMessage(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'message' in error
    ? String((error as { message?: unknown }).message ?? '')
    : undefined;
}

function getErrorData(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'data' in error ? (error as { data?: unknown }).data : undefined;
}

function buildDiscoveryErrorMessage(error: unknown): string {
  const status = getErrorStatus(error);
  return status
    ? `Failed to discover job metrics (HTTP ${status}). Check browser console for [MetricDiscovery] details.`
    : 'Failed to discover job metrics. Check browser console for [MetricDiscovery] details.';
}

function logDiscoveryDebug(
  message: string,
  context: {
    clusterId: string;
    jobId: number;
    nodeCount: number;
    metricsType: ClusterSummary['metricsType'];
    instanceLabel: string;
    aggregationNodeLabels: string[];
    discoveryNode?: string;
    timeRange: { from: string; to: string };
    seriesQueries: DiscoveryQueryArgs[];
    fallbackQueries?: DiscoveryFallbackArgs[];
    fallbackFailures?: DiscoveryFallbackFailure[];
    errorStatus?: number;
    errorMessage?: string;
    errorData?: unknown;
  }
) {
  console.error('[MetricDiscovery]', message, context);
}

async function runDiscoveryFallbackQueries({
  fallbackQueries,
  queryInstant,
  debugContextBase,
}: {
  fallbackQueries: DiscoveryFallbackArgs[];
  queryInstant: (args: DiscoveryFallbackArgs) => Promise<PromSeries[]>;
  debugContextBase: {
    clusterId: string;
    jobId: number;
    nodeCount: number;
    metricsType: ClusterSummary['metricsType'];
    instanceLabel: string;
    aggregationNodeLabels: string[];
    discoveryNode?: string;
    timeRange: { from: string; to: string };
    seriesQueries: DiscoveryQueryArgs[];
  };
}): Promise<{ nodeSeries: PromSeries[]; gpuSeries: PromSeries[] }> {
  const grouped = fallbackQueries.reduce<Record<DiscoveryTarget, DiscoveryFallbackArgs[]>>(
    (acc, query) => {
      acc[query.target].push(query);
      return acc;
    },
    { node: [], gpu: [] }
  );

  const executeTarget = async (target: DiscoveryTarget): Promise<PromSeries[]> => {
    const failures: DiscoveryFallbackFailure[] = [];

    for (const probe of grouped[target]) {
      try {
        return await queryInstant(probe);
      } catch (error) {
        const failure = {
          ...probe,
          errorStatus: getErrorStatus(error),
          errorMessage: getErrorMessage(error),
          errorData: getErrorData(error),
        };
        failures.push(failure);
      }
    }

    const lastFailure = failures[failures.length - 1];
    logDiscoveryDebug('All fallback discovery probes failed', {
      ...debugContextBase,
      fallbackQueries: grouped[target],
      fallbackFailures: failures,
      errorStatus: lastFailure?.errorStatus,
      errorMessage: lastFailure?.errorMessage,
      errorData: lastFailure?.errorData,
    });
    throw new Error(buildDiscoveryErrorMessage(lastFailure));
  };

  const [nodeSeries, gpuSeries] = await Promise.all([executeTarget('node'), executeTarget('gpu')]);
  return { nodeSeries, gpuSeries };
}

export async function discoverJobMetrics({
  job,
  cluster,
  timeRange,
  querySeries = querySeriesFromDatasource,
  queryInstant = queryInstantFromDatasource,
}: {
  job: JobRecord;
  cluster: ClusterSummary;
  timeRange: { from: string; to: string };
  querySeries?: (args: DiscoveryQueryArgs) => Promise<PromSeries[]>;
  queryInstant?: (args: DiscoveryFallbackArgs) => Promise<PromSeries[]>;
}): Promise<MetricExplorerEntry[]> {
  const normalizedTimeRange = {
    from: normalizePrometheusTime(timeRange.from, false),
    to: normalizePrometheusTime(timeRange.to, true),
  };
  const discoveryNode = job.nodes[0];
  const filterMatcher = buildFilterMatcher(cluster.metricsFilterLabel, cluster.metricsFilterValue, cluster.metricsType);
  const nodeMatcher = buildDiscoveryMatcher({
    node: discoveryNode,
    instanceLabel: cluster.instanceLabel,
    port: cluster.nodeExporterPort,
    mode: cluster.nodeMatcherMode,
    metricsType: cluster.metricsType,
    filterMatcher,
  });
  const gpuMatcher = buildDiscoveryMatcher({
    node: discoveryNode,
    instanceLabel: cluster.instanceLabel,
    port: cluster.dcgmExporterPort,
    mode: cluster.nodeMatcherMode,
    metricsType: cluster.metricsType,
    filterMatcher,
  });

  const queryArgs: DiscoveryQueryArgs[] = [
    {
      target: 'node',
      datasourceUid: cluster.metricsDatasourceUid,
      matcher: nodeMatcher,
      from: normalizedTimeRange.from,
      to: normalizedTimeRange.to,
    },
    {
      target: 'gpu',
      datasourceUid: cluster.metricsDatasourceUid,
      matcher: gpuMatcher,
      from: normalizedTimeRange.from,
      to: normalizedTimeRange.to,
    },
  ];
  const fallbackArgs: DiscoveryFallbackArgs[] = queryArgs.flatMap((args) =>
    buildDiscoveryFallbackArgs(
      args.matcher,
      cluster.aggregationNodeLabels,
      cluster.metricsType,
      args.datasourceUid,
      args.target,
      normalizedTimeRange.to
    )
  );
  const debugContextBase = {
    clusterId: cluster.id,
    jobId: job.jobId,
    nodeCount: job.nodeCount,
    metricsType: cluster.metricsType,
    instanceLabel: cluster.instanceLabel,
    aggregationNodeLabels: cluster.aggregationNodeLabels,
    discoveryNode,
    timeRange: normalizedTimeRange,
    seriesQueries: queryArgs,
  };

  let nodeSeries: PromSeries[];
  let gpuSeries: PromSeries[];
  try {
    [nodeSeries, gpuSeries] = await Promise.all(queryArgs.map((args) => querySeries(args)));
  } catch (error) {
    if (!isSeriesQueryUnsupported(error)) {
      logDiscoveryDebug('Series discovery failed', {
        ...debugContextBase,
        errorStatus: getErrorStatus(error),
        errorMessage: getErrorMessage(error),
        errorData: getErrorData(error),
      });
      throw new Error(buildDiscoveryErrorMessage(error));
    }

    try {
      ({ nodeSeries, gpuSeries } = await runDiscoveryFallbackQueries({
        fallbackQueries: fallbackArgs,
        queryInstant,
        debugContextBase,
      }));
    } catch (fallbackError) {
      throw fallbackError;
    }
  }

  return buildMetricExplorerEntries({
    nodeSeries,
    gpuSeries,
    aggregationNodeLabels: cluster.aggregationNodeLabels,
  });
}
