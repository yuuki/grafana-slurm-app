import { getBackendSrv } from '@grafana/runtime';
import { ClusterSummary, JobRecord } from '../../api/types';
import { buildFilterMatcher, buildInstanceMatcher, formatLabelNameForDatasource } from '../JobDashboard/scenes/model';

export interface JobUtilization {
  cpuPercent: number | undefined;
  gpuPercent: number | undefined;
}

async function queryInstantValue(
  datasourceUid: string,
  expr: string,
  time: number
): Promise<number | undefined> {
  try {
    const response = await getBackendSrv().get<{
      data?: { result?: Array<{ value?: [number, string] }> };
    }>(`/api/datasources/proxy/uid/${datasourceUid}/api/v1/query`, {
      query: expr,
      time: String(time),
    });
    const raw = response?.data?.result?.[0]?.value?.[1];
    if (raw === undefined || raw === null) {
      return undefined;
    }
    const parsed = parseFloat(raw);
    return isNaN(parsed) ? undefined : parsed;
  } catch {
    return undefined;
  }
}

async function queryInstantPerInstance(
  datasourceUid: string,
  expr: string,
  time: number,
  instanceLabel: string
): Promise<Map<string, number>> {
  try {
    const response = await getBackendSrv().get<{
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
  const values: number[] = [];
  for (const [instance, value] of instanceValues) {
    const matched = job.nodes.some((node) =>
      mode === 'hostname' ? instance === node : instance === node || instance.startsWith(`${node}:`)
    );
    if (matched) {
      values.push(value);
    }
  }
  if (values.length === 0) {
    return undefined;
  }
  return values.reduce((a, b) => a + b, 0) / values.length;
}

const MAX_NODES_PER_CHUNK = 50;

function mergeInstanceMaps(maps: Array<Map<string, number>>): Map<string, number> {
  const merged = new Map<string, number>();
  for (const m of maps) {
    for (const [k, v] of m) {
      merged.set(k, v);
    }
  }
  return merged;
}

async function queryInstantPerInstanceChunked(
  datasourceUid: string,
  buildExpr: (matcher: string) => string,
  nodes: string[],
  cluster: ClusterSummary,
  time: number
): Promise<Map<string, number>> {
  const filterMatcher = buildFilterMatcher(
    cluster.metricsFilterLabel,
    cluster.metricsFilterValue,
    cluster.metricsType
  );
  const formattedLabel = formatLabelNameForDatasource(cluster.instanceLabel, cluster.metricsType);

  const chunks: string[][] = [];
  for (let i = 0; i < nodes.length; i += MAX_NODES_PER_CHUNK) {
    chunks.push(nodes.slice(i, i + MAX_NODES_PER_CHUNK));
  }

  const chunkResults = await Promise.all(
    chunks.map((chunk) => {
      const instanceMatcher = buildInstanceMatcher(
        chunk,
        cluster.instanceLabel,
        cluster.nodeMatcherMode,
        cluster.metricsType
      );
      const matcher = [instanceMatcher, filterMatcher].filter(Boolean).join(',');
      return queryInstantPerInstance(datasourceUid, buildExpr(matcher), time, formattedLabel);
    })
  );

  return mergeInstanceMaps(chunkResults);
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
  const time = Math.floor(Date.now() / 1000);
  const formattedLabel = formatLabelNameForDatasource(cluster.instanceLabel, cluster.metricsType);

  const hasGpuJobs = runningJobs.some((j) => j.gpusTotal > 0);
  const [cpuValues, gpuValues] = await Promise.all([
    queryInstantPerInstanceChunked(
      cluster.metricsDatasourceUid,
      (matcher) => `avg by(${formattedLabel}) (1 - rate(node_cpu_seconds_total{mode="idle",${matcher}}[5m])) * 100`,
      allNodes,
      cluster,
      time
    ),
    hasGpuJobs
      ? queryInstantPerInstanceChunked(
          cluster.metricsDatasourceUid,
          (matcher) => `avg by(${formattedLabel}) (DCGM_FI_DEV_GPU_UTIL{${matcher}})`,
          allNodes,
          cluster,
          time
        )
      : Promise.resolve(new Map<string, number>()),
  ]);

  for (const job of runningJobs) {
    const cpuPercent = averageForJob(job, cpuValues, cluster.nodeMatcherMode);
    const gpuPercent =
      job.gpusTotal > 0 ? averageForJob(job, gpuValues, cluster.nodeMatcherMode) : undefined;
    result.set(`${job.clusterId}-${job.jobId}`, { cpuPercent, gpuPercent });
  }

  return result;
}

export async function fetchJobUtilization(
  job: JobRecord,
  cluster: ClusterSummary
): Promise<JobUtilization> {
  if (!cluster.metricsDatasourceUid || job.nodes.length === 0) {
    return { cpuPercent: undefined, gpuPercent: undefined };
  }

  const instanceMatcher = buildInstanceMatcher(
    job.nodes,
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

  const time =
    job.endTime > 0
      ? Math.floor((job.startTime + job.endTime) / 2)
      : Math.floor(Date.now() / 1000);

  const cpuPercent = await queryInstantValue(
    cluster.metricsDatasourceUid,
    `avg(1 - rate(node_cpu_seconds_total{mode="idle",${matcher}}[5m])) * 100`,
    time
  );

  let gpuPercent: number | undefined;
  if (job.gpusTotal > 0) {
    gpuPercent = await queryInstantValue(
      cluster.metricsDatasourceUid,
      `avg(DCGM_FI_DEV_GPU_UTIL{${matcher}})`,
      time
    );
  }

  return { cpuPercent, gpuPercent };
}
