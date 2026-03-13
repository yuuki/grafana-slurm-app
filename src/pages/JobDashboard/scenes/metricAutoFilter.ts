import { getBackendSrv } from '@grafana/runtime';
import { AutoFilterMetricsRequest, AutoFilterMetricSeries, ClusterSummary, JobRecord } from '../../../api/types';
import { MetricExplorerEntry } from './metricDiscovery';
import { buildFilterMatcher, buildInstanceMatcher } from './model';

const MAX_METRIC_MATCHER_LENGTH = 1500;

interface PrometheusMatrixResult {
  metric: Record<string, string>;
  values?: Array<[number, string]>;
}

interface PrometheusMatrixResponse {
  data?: {
    result?: PrometheusMatrixResult[];
  };
}

function escapePromRegex(value: string): string {
  return value.replace(/[\\.^$|?*+()[\]{}]/g, '\\$&');
}

function resolveTimeRangePoint(value: string): number {
  if (value === 'now') {
    return Date.now();
  }
  return Date.parse(value);
}

function buildQueryStep(from: string, to: string): string {
  const fromMs = resolveTimeRangePoint(from);
  const toMs = resolveTimeRangePoint(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return '15s';
  }

  const seconds = Math.max(Math.ceil((toMs - fromMs) / 1000 / 120), 15);
  return `${seconds}s`;
}

function serializeLabels(metric: Record<string, string>): string {
  const labels = Object.keys(metric)
    .filter((key) => key !== '__name__')
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${key}=${metric[key]}`);

  return labels.join(',');
}

function buildSeriesId(metric: Record<string, string>): string | null {
  const metricName = metric.__name__;
  if (!metricName) {
    return null;
  }

  const labels = serializeLabels(metric);
  return labels ? `${metricName}:${labels}` : metricName;
}

async function queryRangeFromDatasource({
  datasourceUid,
  query,
  from,
  to,
  step,
}: {
  datasourceUid: string;
  query: string;
  from: string;
  to: string;
  step: string;
}): Promise<PrometheusMatrixResult[]> {
  const response = await getBackendSrv().get<PrometheusMatrixResponse>(`/api/datasources/proxy/uid/${datasourceUid}/api/v1/query_range`, {
    query,
    start: from,
    end: to,
    step,
  });

  return Array.isArray(response?.data?.result) ? response.data.result : [];
}

function buildMetricQuery({
  cluster,
  job,
  metricNames,
}: {
  cluster: ClusterSummary;
  job: JobRecord;
  metricNames: string[];
}): string {
  const metricMatcher = `__name__=~"${metricNames.map(escapePromRegex).join('|')}"`;
  const instanceMatcher = buildInstanceMatcher(job.nodes, cluster.instanceLabel, cluster.nodeMatcherMode, cluster.metricsType);
  const filterMatcher = buildFilterMatcher(cluster.metricsFilterLabel, cluster.metricsFilterValue, cluster.metricsType);

  return `{${[metricMatcher, instanceMatcher, filterMatcher].filter(Boolean).join(',')}}`;
}

function chunkMetricNames(metricNames: string[]): string[][] {
  const chunks: string[][] = [];
  let currentChunk: string[] = [];
  let currentLength = 0;

  for (const metricName of metricNames) {
    const escapedMetricName = escapePromRegex(metricName);
    const nextLength = currentChunk.length === 0 ? escapedMetricName.length : currentLength + 1 + escapedMetricName.length;

    if (currentChunk.length > 0 && nextLength > MAX_METRIC_MATCHER_LENGTH) {
      chunks.push(currentChunk);
      currentChunk = [metricName];
      currentLength = escapedMetricName.length;
      continue;
    }

    currentChunk.push(metricName);
    currentLength = nextLength;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function toMetricKeyMap(rawEntries: MetricExplorerEntry[]): Map<string, string> {
  const entries = new Map<string, string>();

  for (const entry of rawEntries) {
    if (entry.metricName) {
      entries.set(entry.metricName, entry.key);
    }
  }

  return entries;
}

function aggregateSeriesByMetricKey(series: AutoFilterMetricSeries[]): AutoFilterMetricSeries[] {
  const aggregated = new Map<
    string,
    {
      metricKey: string;
      metricName: string;
      valuesByIndex: Array<Array<number | null>>;
    }
  >();

  for (const item of series) {
    const current =
      aggregated.get(item.metricKey) ??
      {
        metricKey: item.metricKey,
        metricName: item.metricName,
        valuesByIndex: item.values.map(() => [] as Array<number | null>),
      };

    item.values.forEach((value, index) => {
      current.valuesByIndex[index].push(value);
    });
    aggregated.set(item.metricKey, current);
  }

  return [...aggregated.values()].map((item) => ({
    seriesId: item.metricKey,
    metricKey: item.metricKey,
    metricName: item.metricName,
    values: item.valuesByIndex.map((values) => {
      const presentValues = values.filter((value): value is number => value !== null);
      if (presentValues.length === 0) {
        return null;
      }
      return presentValues.reduce((sum, value) => sum + value, 0) / presentValues.length;
    }),
  }));
}

export async function collectMetricAutoFilterInput({
  cluster,
  job,
  rawEntries,
  timeRange,
  queryRange = queryRangeFromDatasource,
}: {
  cluster: ClusterSummary;
  job: JobRecord;
  rawEntries: MetricExplorerEntry[];
  timeRange: { from: string; to: string };
  queryRange?: (args: { datasourceUid: string; query: string; from: string; to: string; step: string }) => Promise<PrometheusMatrixResult[]>;
}): Promise<AutoFilterMetricsRequest> {
  const metricNames = new Set<string>();
  for (const entry of rawEntries) {
    if (!entry.metricName) {
      continue;
    }
    metricNames.add(entry.metricName);
  }

  const step = buildQueryStep(timeRange.from, timeRange.to);
  const keyMap = toMetricKeyMap(rawEntries);
  const results = await Promise.all(
    chunkMetricNames([...metricNames].sort()).map(async (chunk) => ({
      result: await queryRange({
        datasourceUid: cluster.metricsDatasourceUid,
        query: buildMetricQuery({
          cluster,
          job,
          metricNames: chunk,
        }),
        from: timeRange.from,
        to: timeRange.to,
        step,
      }),
    }))
  );

  const timestamps = new Set<number>();
  const series: Array<AutoFilterMetricSeries & { valueMap: Map<number, number | null> }> = [];

  for (const { result } of results) {
    for (const item of result) {
      const metricName = item.metric.__name__;
      if (!metricName) {
        continue;
      }
      const metricKey = keyMap.get(metricName);
      const seriesId = buildSeriesId(item.metric);
      if (!metricKey || !seriesId) {
        continue;
      }

      const valueMap = new Map<number, number | null>();
      for (const [timestamp, rawValue] of item.values ?? []) {
        const timestampMs = Math.round(timestamp * 1000);
        timestamps.add(timestampMs);
        valueMap.set(timestampMs, rawValue === 'NaN' ? null : Number(rawValue));
      }

      series.push({
        seriesId,
        metricKey,
        metricName,
        values: [],
        valueMap,
      });
    }
  }

  const orderedTimestamps = [...timestamps].sort((left, right) => left - right);
  const normalizedSeries = series.map((item) => {
    return {
      seriesId: item.seriesId,
      metricKey: item.metricKey,
      metricName: item.metricName,
      values: orderedTimestamps.map((timestamp) => item.valueMap.get(timestamp) ?? null),
    };
  });

  return {
    clusterId: cluster.id,
    jobId: String(job.jobId),
    timestamps: orderedTimestamps,
    series: aggregateSeriesByMetricKey(normalizedSeries),
  };
}
