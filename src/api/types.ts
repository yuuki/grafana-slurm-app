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
  metricsFilterLabel: string;
  metricsFilterValue: string;
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

export type SlurmJob = JobRecord;

export interface ListJobsResponse {
  jobs: JobRecord[];
  nextCursor?: string;
  total: number;
}

export interface ListJobMetadataOptionsResponse {
  values: string[];
}

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
  limit?: number;
}
