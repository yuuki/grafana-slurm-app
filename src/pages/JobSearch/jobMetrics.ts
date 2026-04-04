import { getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import { ClusterSummary, JobRecord } from '../../api/types';
import { buildFilterMatcher, buildInstanceMatcher, formatLabelNameForDatasource } from '../JobDashboard/scenes/model';
import { jobKey } from './model';

export interface JobUtilization {
  cpuPercent: number | undefined;
  gpuPercent: number | undefined;
}

export const DEFAULT_CPU_EXPR = 'avg by(${formattedLabel}) (1 - rate(node_cpu_seconds_total{mode="idle",${matcher}}[5m])) * 100';
export const DEFAULT_GPU_EXPR = 'avg by(${formattedLabel}) (DCGM_FI_DEV_GPU_UTIL{${instanceMatcher}})';

function buildUtilizationExpr(template: string, matcher: string, instanceMatcher: string, formattedLabel: string): string {
  return template
    .replace(/\$\{matcher\}/g, matcher)
    .replace(/\$\{instanceMatcher\}/g, instanceMatcher)
    .replace(/\$\{formattedLabel\}/g, formattedLabel);
}

type TimeSeries = Array<[number, number]>;

async function queryRangePerInstance(
  datasourceUid: string,
  expr: string,
  start: number,
  end: number,
  step: number,
  instanceLabel: string
): Promise<Map<string, TimeSeries>> {
  try {
    const params = new URLSearchParams();
    params.set('query', expr);
    params.set('start', String(start));
    params.set('end', String(end));
    params.set('step', `${step}s`);

    const res = await lastValueFrom(
      getBackendSrv().fetch<{
        data?: {
          result?: Array<{
            metric?: Record<string, string>;
            values?: Array<[number, string]>;
          }>;
        };
      }>({
        url: `/api/datasources/proxy/uid/${datasourceUid}/api/v1/query_range`,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: params.toString(),
      })
    );
    const response = res.data;
    const map = new Map<string, TimeSeries>();
    for (const item of response?.data?.result ?? []) {
      const instanceValue = item.metric?.[instanceLabel];
      if (!instanceValue) {
        continue;
      }
      const series: TimeSeries = [];
      for (const [ts, raw] of item.values ?? []) {
        const parsed = parseFloat(raw);
        if (!isNaN(parsed)) {
          series.push([ts, parsed]);
        }
      }
      if (series.length > 0) {
        map.set(instanceValue, series);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function matchesNode(instance: string, nodeSet: Set<string>, nodes: string[], mode: 'host:port' | 'hostname'): boolean {
  return mode === 'hostname'
    ? nodeSet.has(instance)
    : nodeSet.has(instance) || nodes.some((node) => instance.startsWith(`${node}:`));
}

function averageForJobOverRange(
  job: JobRecord,
  instanceTimeSeries: Map<string, TimeSeries>,
  mode: 'host:port' | 'hostname'
): number | undefined {
  const nodeSet = new Set(job.nodes);
  const jobEnd = job.endTime === 0 ? Math.floor(Date.now() / 1000) : job.endTime;
  const values: number[] = [];
  for (const [instance, series] of instanceTimeSeries) {
    if (!matchesNode(instance, nodeSet, job.nodes, mode)) {
      continue;
    }
    for (const [ts, value] of series) {
      if (ts >= job.startTime && ts <= jobEnd) {
        values.push(value);
      }
    }
  }
  if (values.length === 0) {
    return undefined;
  }
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export async function fetchJobsUtilizationBatch(
  jobs: JobRecord[],
  cluster: ClusterSummary
): Promise<Map<string, JobUtilization>> {
  const result = new Map<string, JobUtilization>();

  if (!cluster.metricsDatasourceUid) {
    return result;
  }

  const targetJobs = jobs.filter((j) => j.nodes.length > 0);
  if (targetJobs.length === 0) {
    return result;
  }

  const allNodes = [...new Set(targetJobs.flatMap((j) => j.nodes))];
  const instanceMatcher = buildInstanceMatcher(
    allNodes,
    cluster.instanceLabel,
    cluster.nodeMatcherMode,
    cluster.metricsType
  );
  const filterMatcher = buildFilterMatcher(
    cluster.metricsFilterLabel,
    cluster.metricsFilterValue,
    cluster.metricsType
  );
  const matcher = [instanceMatcher, filterMatcher].filter(Boolean).join(',');
  const now = Math.floor(Date.now() / 1000);
  const start = Math.min(...targetJobs.map((j) => j.startTime));
  const end = Math.max(...targetJobs.map((j) => (j.endTime === 0 ? now : j.endTime)));
  const totalRange = end - start;
  const minJobDuration = Math.min(
    ...targetJobs.map((j) => {
      const jobEnd = j.endTime === 0 ? now : j.endTime;
      return jobEnd - j.startTime;
    })
  );
  // Use the lesser of range-based and duration-based steps so short jobs get data points,
  // but cap total points at 50000/series to keep response size manageable
  const step = Math.max(60, Math.ceil(totalRange / 50000), Math.min(
    Math.ceil(totalRange / 500),
    Math.floor(Math.max(minJobDuration, 120) / 2)
  ));
  const formattedLabel = formatLabelNameForDatasource(cluster.instanceLabel, cluster.metricsType);

  const hasGpuJobs = targetJobs.some((j) => j.gpusTotal > 0);
  const [cpuSeries, gpuSeries] = await Promise.all([
    queryRangePerInstance(
      cluster.metricsDatasourceUid,
      buildUtilizationExpr(cluster.cpuUtilizationExpr || DEFAULT_CPU_EXPR, matcher, instanceMatcher, formattedLabel),
      start,
      end,
      step,
      cluster.instanceLabel
    ),
    hasGpuJobs
      ? queryRangePerInstance(
          cluster.metricsDatasourceUid,
          buildUtilizationExpr(cluster.gpuUtilizationExpr || DEFAULT_GPU_EXPR, matcher, instanceMatcher, formattedLabel),
          start,
          end,
          step,
          cluster.instanceLabel
        )
      : Promise.resolve(new Map<string, TimeSeries>()),
  ]);

  for (const job of targetJobs) {
    const cpuPercent = averageForJobOverRange(job, cpuSeries, cluster.nodeMatcherMode);
    const gpuPercent =
      job.gpusTotal > 0 ? averageForJobOverRange(job, gpuSeries, cluster.nodeMatcherMode) : undefined;
    result.set(jobKey(job.clusterId, job.jobId), { cpuPercent, gpuPercent });
  }

  return result;
}
