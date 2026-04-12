import { FieldConfigSource } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import { ClusterSummary, JobRecord } from '../../../api/types';
import { buildFilterMatcher, buildInstanceMatcher, formatLabelNameForDatasource, normalizePrometheusTime } from './model';

type MetricFieldConfig = Pick<FieldConfigSource, 'defaults' | 'overrides'>;
type PromSeries = Record<string, string>;
type DiscoveryQueryArgs = { datasourceUid: string; matcher: string; from: string; to: string };
type DiscoveryFallbackArgs = { probe: string; datasourceUid: string; expr: string; time: string };
type DiscoveryFallbackFailure = DiscoveryFallbackArgs & { errorStatus?: number; errorMessage?: string; errorData?: unknown };
type MetadataQueryArgs = { datasourceUid: string };
type PrometheusMetadataResponse = { data?: Record<string, Array<{ type?: string; help?: string }>> };

export type PrometheusMetricType = 'counter' | 'gauge' | 'histogram' | 'summary' | 'unknown';

const DEFAULT_FIELD_CONFIG: MetricFieldConfig = { defaults: {}, overrides: [] };

export interface MetricExplorerEntry {
  kind: 'raw';
  key: string;
  title: string;
  description: string;
  legendFormat: string;
  fieldConfig: MetricFieldConfig;
  metricName?: string;
  labelKeys: string[];
  metricType: PrometheusMetricType;
}

function defaultLegendFormat(labelKeys: string[]): string {
  if (labelKeys.includes('gpu')) {
    return '{{instance}} / GPU {{gpu}}';
  }
  if (labelKeys.includes('device')) {
    return '{{instance}} {{device}}';
  }
  return '{{instance}}';
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function buildRawMetricEntry(metricName: string, labelKeys: string[], metricType: PrometheusMetricType = 'unknown'): MetricExplorerEntry {
  return {
    kind: 'raw',
    key: buildRawMetricKey(metricName),
    title: metricName,
    description: '',
    legendFormat: defaultLegendFormat(labelKeys),
    fieldConfig: DEFAULT_FIELD_CONFIG,
    metricName,
    labelKeys,
    metricType,
  };
}

// Fallback heuristic based on Prometheus naming conventions.
// The metadata API result takes precedence when available.
export function inferMetricTypeFromName(metricName: string): PrometheusMetricType {
  const lower = metricName.toLowerCase();
  if (lower.endsWith('_total')) {
    return 'counter';
  }
  if (lower.endsWith('_bucket')) {
    return 'histogram';
  }
  if (lower.endsWith('_count') || lower.endsWith('_sum')) {
    return 'counter';
  }
  return 'unknown';
}

function resolvePrometheusMetricType(typeString?: string): PrometheusMetricType {
  switch (typeString) {
    case 'counter': return 'counter';
    case 'gauge': return 'gauge';
    case 'histogram': return 'histogram';
    case 'summary': return 'summary';
    default: return 'unknown';
  }
}

async function queryMetadataFromDatasource({ datasourceUid }: MetadataQueryArgs): Promise<Map<string, PrometheusMetricType>> {
  const response = await getBackendSrv().get<PrometheusMetadataResponse>(
    `/api/datasources/proxy/uid/${datasourceUid}/api/v1/metadata`
  );

  const result = new Map<string, PrometheusMetricType>();
  if (response?.data) {
    for (const [metricName, entries] of Object.entries(response.data)) {
      result.set(metricName, resolvePrometheusMetricType(entries?.[0]?.type));
    }
  }
  return result;
}

export function buildRawMetricKey(metricName: string): string {
  return `raw:${metricName}`;
}

export function parseMetricKey(metricKey: string): { kind: 'raw'; metricName: string } | null {
  if (!metricKey.startsWith('raw:')) {
    return null;
  }
  const legacyGpuPrefix = 'raw:gpu:';
  const legacyNodePrefix = 'raw:node:';
  if (metricKey.startsWith(legacyGpuPrefix)) {
    return { kind: 'raw', metricName: metricKey.slice(legacyGpuPrefix.length) };
  }
  if (metricKey.startsWith(legacyNodePrefix)) {
    return { kind: 'raw', metricName: metricKey.slice(legacyNodePrefix.length) };
  }
  const metricName = metricKey.slice('raw:'.length);
  return metricName ? { kind: 'raw', metricName } : null;
}

export function migrateLegacyPanelKey(metricId: string): string {
  const parsed = parseMetricKey(metricId);
  if (parsed) {
    return buildRawMetricKey(parsed.metricName);
  }
  return metricId;
}

export function buildMetricExplorerEntries({ series }: { series: PromSeries[] }): MetricExplorerEntry[] {
  const discoveredMetrics = new Map<string, { metricName: string; labelKeys: string[] }>();

  for (const item of series) {
    const metricName = item.__name__;
    if (!metricName) {
      continue;
    }

    const labelKeys = dedupe(Object.keys(item).filter((key) => key !== '__name__')).sort();
    const existing = discoveredMetrics.get(metricName);
    if (existing) {
      existing.labelKeys = dedupe([...existing.labelKeys, ...labelKeys]).sort();
      continue;
    }

    discoveredMetrics.set(metricName, { metricName, labelKeys });
  }

  return [...discoveredMetrics.values()]
    .map((metric) => buildRawMetricEntry(metric.metricName, metric.labelKeys))
    .sort((left, right) => left.title.localeCompare(right.title));
}

export function getMetricEntryByKey(metricKey: string): MetricExplorerEntry | undefined {
  const parsed = parseMetricKey(metricKey);
  if (!parsed) {
    return undefined;
  }

  const metricType = inferMetricTypeFromName(parsed.metricName);
  return buildRawMetricEntry(parsed.metricName, ['instance'], metricType);
}

function buildDiscoveryMatcher(cluster: ClusterSummary, job: JobRecord): string {
  const filterMatcher = buildFilterMatcher(cluster.metricsFilterLabel, cluster.metricsFilterValue, cluster.metricsType);
  const instanceMatcher = buildInstanceMatcher(
    job.nodes.length > 0 ? [job.nodes[0]] : [],
    cluster.instanceLabel,
    cluster.nodeMatcherMode,
    cluster.metricsType
  );
  return `{${[instanceMatcher, filterMatcher].filter(Boolean).join(',')}}`;
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

function buildDiscoveryFallbackLabelNames(cluster: ClusterSummary): string[] {
  return dedupe(['__name__', 'instance', 'gpu', 'device', ...cluster.aggregationNodeLabels]).map((label) =>
    formatLabelNameForDatasource(label, cluster.metricsType)
  );
}

function buildDiscoveryFallbackArgs(
  matcher: string,
  cluster: ClusterSummary,
  datasourceUid: string,
  time: string
): DiscoveryFallbackArgs[] {
  const labelNames = buildDiscoveryFallbackLabelNames(cluster);
  const byClause = labelNames.join(',');

  return [
    {
      probe: 'count_by_selector',
      datasourceUid,
      expr: `count by(${byClause}) (${matcher})`,
      time,
    },
    {
      probe: 'count_by_last_over_time',
      datasourceUid,
      expr: `count by(${byClause}) (last_over_time(${matcher}[5m]))`,
      time,
    },
    {
      probe: 'last_over_time',
      datasourceUid,
      expr: `last_over_time(${matcher}[5m])`,
      time,
    },
    {
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
    seriesQuery: DiscoveryQueryArgs;
    fallbackQueries?: DiscoveryFallbackArgs[];
    fallbackFailures?: DiscoveryFallbackFailure[];
    errorStatus?: number;
    errorMessage?: string;
    errorData?: unknown;
  }
) {
  console.warn('[MetricDiscovery]', message, context);
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
    seriesQuery: DiscoveryQueryArgs;
  };
}): Promise<PromSeries[]> {
  const failures: DiscoveryFallbackFailure[] = [];

  for (const probe of fallbackQueries) {
    try {
      return await queryInstant(probe);
    } catch (error) {
      failures.push({
        ...probe,
        errorStatus: getErrorStatus(error),
        errorMessage: getErrorMessage(error),
        errorData: getErrorData(error),
      });
    }
  }

  const lastFailure = failures[failures.length - 1];
  logDiscoveryDebug('All fallback discovery probes failed', {
    ...debugContextBase,
    fallbackQueries,
    fallbackFailures: failures,
    errorStatus: lastFailure?.errorStatus,
    errorMessage: lastFailure?.errorMessage,
    errorData: lastFailure?.errorData,
  });
  throw new Error(buildDiscoveryErrorMessage(lastFailure));
}

function enrichEntriesWithMetricType(
  entries: MetricExplorerEntry[],
  metadataMap: Map<string, PrometheusMetricType>
): MetricExplorerEntry[] {
  return entries.map((entry) => {
    if (!entry.metricName) {
      return entry;
    }
    const apiType = metadataMap.get(entry.metricName);
    const metricType = apiType ?? inferMetricTypeFromName(entry.metricName);
    return { ...entry, metricType };
  });
}

export async function discoverJobMetrics({
  job,
  cluster,
  timeRange,
  querySeries = querySeriesFromDatasource,
  queryInstant = queryInstantFromDatasource,
  queryMetadata = queryMetadataFromDatasource,
}: {
  job: JobRecord;
  cluster: ClusterSummary;
  timeRange: { from: string; to: string };
  querySeries?: (args: DiscoveryQueryArgs) => Promise<PromSeries[]>;
  queryInstant?: (args: DiscoveryFallbackArgs) => Promise<PromSeries[]>;
  queryMetadata?: (args: MetadataQueryArgs) => Promise<Map<string, PrometheusMetricType>>;
}): Promise<MetricExplorerEntry[]> {
  const normalizedTimeRange = {
    from: normalizePrometheusTime(timeRange.from, false),
    to: normalizePrometheusTime(timeRange.to, true),
  };

  const matcher = buildDiscoveryMatcher(cluster, job);
  const seriesQuery = {
    datasourceUid: cluster.metricsDatasourceUid,
    matcher,
    from: normalizedTimeRange.from,
    to: normalizedTimeRange.to,
  };
  const fallbackQueries = buildDiscoveryFallbackArgs(
    matcher,
    cluster,
    cluster.metricsDatasourceUid,
    normalizedTimeRange.to
  );
  const debugContextBase = {
    clusterId: cluster.id,
    jobId: job.jobId,
    nodeCount: job.nodeCount,
    metricsType: cluster.metricsType,
    instanceLabel: cluster.instanceLabel,
    aggregationNodeLabels: cluster.aggregationNodeLabels,
    discoveryNode: job.nodes[0],
    timeRange: normalizedTimeRange,
    seriesQuery,
  };

  let metadataMap = new Map<string, PrometheusMetricType>();
  try {
    metadataMap = await queryMetadata({ datasourceUid: cluster.metricsDatasourceUid });
  } catch {
    // metadata API failure is non-fatal; fall back to naming convention heuristic
  }

  try {
    const series = await querySeries(seriesQuery);
    return enrichEntriesWithMetricType(buildMetricExplorerEntries({ series }), metadataMap);
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
  }

  const series = await runDiscoveryFallbackQueries({
    fallbackQueries,
    queryInstant,
    debugContextBase,
  });
  return enrichEntriesWithMetricType(buildMetricExplorerEntries({ series }), metadataMap);
}
