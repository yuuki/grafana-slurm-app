import { getBackendSrv } from '@grafana/runtime';
import { ClusterSummary, JobRecord } from '../../api/types';
import { buildFilterMatcher, buildInstanceMatcher, formatLabelNameForDatasource } from '../JobDashboard/scenes/model';
import { jobKey } from './model';

export interface JobUtilization {
  cpuPercent: number | undefined;
  gpuPercent: number | undefined;
}

export const DEFAULT_CPU_EXPR = 'avg by(${formattedLabel}) (1 - rate(node_cpu_seconds_total{mode="idle",${matcher}}[5m])) * 100';
export const DEFAULT_GPU_EXPR = 'avg by(${formattedLabel}) (DCGM_FI_DEV_GPU_UTIL{${matcher}})';

function buildUtilizationExpr(template: string, matcher: string, formattedLabel: string): string {
  return template
    .replace(/\$\{matcher\}/g, matcher)
    .replace(/\$\{formattedLabel\}/g, formattedLabel);
}

async function queryInstantPerInstance(
  datasourceUid: string,
  expr: string,
  time: number,
  instanceLabel: string
): Promise<Map<string, number>> {
  try {
    const response = await getBackendSrv().post<{
      data?: {
        result?: Array<{
          metric?: Record<string, string>;
          value?: [number, string];
        }>;
      };
    }>(`/api/datasources/proxy/uid/${datasourceUid}/api/v1/query`, {
      query: expr,
      time: String(time),
    });
    const map = new Map<string, number>();
    for (const item of response?.data?.result ?? []) {
      const instanceValue = item.metric?.[instanceLabel];
      if (!instanceValue) {
        continue;
      }
      const raw = item.value?.[1];
      if (raw === undefined) {
        continue;
      }
      const parsed = parseFloat(raw);
      if (!isNaN(parsed)) {
        map.set(instanceValue, parsed);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function averageForJob(
  job: JobRecord,
  instanceValues: Map<string, number>,
  mode: 'host:port' | 'hostname'
): number | undefined {
  const nodeSet = new Set(job.nodes);
  const values: number[] = [];
  for (const [instance, value] of instanceValues) {
    const matched =
      mode === 'hostname'
        ? nodeSet.has(instance)
        : nodeSet.has(instance) || job.nodes.some((node) => instance.startsWith(`${node}:`));
    if (matched) {
      values.push(value);
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

  const runningJobs = jobs.filter((j) => j.endTime === 0 && j.nodes.length > 0);
  if (runningJobs.length === 0) {
    return result;
  }

  const allNodes = [...new Set(runningJobs.flatMap((j) => j.nodes))];
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
  const time = Math.floor(Date.now() / 1000);
  const formattedLabel = formatLabelNameForDatasource(cluster.instanceLabel, cluster.metricsType);

  const hasGpuJobs = runningJobs.some((j) => j.gpusTotal > 0);
  const [cpuValues, gpuValues] = await Promise.all([
    queryInstantPerInstance(
      cluster.metricsDatasourceUid,
      buildUtilizationExpr(cluster.cpuUtilizationExpr || DEFAULT_CPU_EXPR, matcher, formattedLabel),
      time,
      cluster.instanceLabel
    ),
    hasGpuJobs
      ? queryInstantPerInstance(
          cluster.metricsDatasourceUid,
          buildUtilizationExpr(cluster.gpuUtilizationExpr || DEFAULT_GPU_EXPR, matcher, formattedLabel),
          time,
          cluster.instanceLabel
        )
      : Promise.resolve(new Map<string, number>()),
  ]);

  for (const job of runningJobs) {
    const cpuPercent = averageForJob(job, cpuValues, cluster.nodeMatcherMode);
    const gpuPercent =
      job.gpusTotal > 0 ? averageForJob(job, gpuValues, cluster.nodeMatcherMode) : undefined;
    result.set(jobKey(job.clusterId, job.jobId), { cpuPercent, gpuPercent });
  }

  return result;
}
