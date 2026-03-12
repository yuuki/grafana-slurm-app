export interface ClusterSummary {
  id: string;
  displayName: string;
  slurmClusterName: string;
  metricsDatasourceUid: string;
  metricsType: 'prometheus' | 'victoriametrics';
  aggregationNodeLabels: string[];
  instanceLabel: string;
  nodeExporterPort: string;
  dcgmExporterPort: string;
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
