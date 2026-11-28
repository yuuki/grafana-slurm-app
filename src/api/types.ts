export interface ClusterSummary {
  id: string;
  displayName: string;
  slurmClusterName: string;
  metricsDatasourceUid: string;
  metricsType: 'prometheus' | 'victoriametrics';
  aggregationNodeLabels: string[];
  instanceLabel: string;
  nodeMatcherMode: 'host:port' | 'hostname';
  defaultTemplateId: string;
  /** Absent when the cluster does not use the job phase segmentation. */
  phases?: PhaseSettings;
  /** Set when the cluster's stored phase settings ask for the feature but are invalid: the feature is off, and this is why. */
  phasesError?: string;
  metricsFilterLabel: string;
  metricsFilterValue: string;
  cpuUtilizationExpr?: string;
  gpuUtilizationExpr?: string;
}

export interface TemplateDefinition {
  id: string;
  title: string;
  capabilities: string[];
}

export interface LinkedDashboardSummary {
  uid: string;
  title: string;
  url: string;
  tags: string[];
}

export interface GrafanaOrgUserSummary {
  login: string;
  displayLabel: string;
}

export interface JobRecord {
  clusterId: string;
  jobId: number;
  name: string;
  user: string;
  account: string;
  partition: string;
  state: string;
  nodes: string[];
  nodeList: string;
  nodeCount: number;
  gpusTotal: number;
  submitTime: number;
  startTime: number;
  endTime: number;
  exitCode: number;
  workDir: string;
  tres: string;
  templateId: string;
}

export interface ListJobsResponse {
  jobs: JobRecord[];
  nextCursor?: string;
  total: number;
}

export interface ListJobMetadataOptionsResponse {
  values: string[];
}

export type FilterGranularity = 'disaggregated' | 'aggregated';

export interface AutoFilterMetricSeries {
  seriesId: string;
  metricKey: string;
  metricName: string;
  values: Array<number | null>;
}

export interface MetricSifterParams {
  searchMethod: 'pelt' | 'binseg' | 'bottomup';
  costModel: 'l1' | 'l2' | 'normal' | 'rbf' | 'linear' | 'clinear' | 'rank' | 'mahalanobis' | 'ar';
  penalty: 'aic' | 'bic' | number;
  penaltyAdjust: number;
  bandwidth: number;
  segmentSelectionMethod: 'weighted_max' | 'max';
  nJobs: number;
  withoutSimpleFilter: boolean;
}

export interface AutoFilterMetricsRequest {
  clusterId: string;
  jobId: string;
  timestamps: number[];
  series: AutoFilterMetricSeries[];
  params?: MetricSifterParams;
}

export interface AutoFilterMetricsResponse {
  selectedMetricKeys: string[];
  selectedSeriesIds?: string[];
  selectedSeriesCount: number;
  totalSeriesCount: number;
  selectedMetricCount: number;
  totalMetricCount: number;
  selectedWindow?: {
    fromMs: number;
    toMs: number;
  };
}

export interface ListClustersResponse {
  clusters: ClusterSummary[];
}

export interface ListTemplatesResponse {
  templates: TemplateDefinition[];
}

export interface ListJobsParams {
  clusterId: string;
  jobId?: number | string;
  user?: string;
  account?: string;
  partition?: string;
  state?: string;
  from?: number;
  to?: number;
  name?: string;
  nodesMin?: number;
  nodesMax?: number;
  elapsedMin?: number;
  elapsedMax?: number;
  nodeNames?: string;
  nodeMatchMode?: string;
  limit?: number;
  cursor?: string;
  template?: string;
}

export interface ListJobMetadataOptionsParams {
  clusterId: string;
  field: 'name' | 'user' | 'account' | 'partition';
  query?: string;
  user?: string;
  account?: string;
  partition?: string;
  state?: string;
  name?: string;
  nodesMin?: number;
  nodesMax?: number;
  elapsedMin?: number;
  elapsedMax?: number;
  nodeNames?: string;
  nodeMatchMode?: string;
  limit?: number;
}

/**
 * Per-cluster settings of the job phase segmentation on the Job Dashboard.
 * The feature is off unless `enabled` is true. Every other field is
 * optional: an unset field selects the default of
 * src/pages/JobDashboard/phases/settings.ts (NVIDIA DCGM exporter and
 * node_exporter names).
 */
export interface PhaseSettings {
  enabled?: boolean;
  /** Per-GPU power gauge, in any unit. */
  gpuPowerMetric?: string;
  /** Per-GPU utilization gauge, in percent. */
  gpuUtilizationMetric?: string;
  /** Counters of bytes written; their rates are added. */
  storageWriteMetrics?: string[];
  /** A GPU is idle in a bucket when none of its utilization samples exceeds this. */
  idleGpuUtilizationPercent?: number;
  /** Every GPU idle for this long, after the job computed, is reported as stalled. */
  stallMinutes?: number;
  /** Smallest write rate, added over the job's nodes, that counts as a write burst. */
  checkpointMinWriteMibPerSecond?: number;
}
