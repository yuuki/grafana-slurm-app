import type { EfficiencySettings, FilterGranularity, MetricSifterParams } from '../../api/types';

export type ConnectionProfile = {
  id: string;
  dbHost: string;
  dbName?: string;
  dbUser: string;
  securePasswordRef: string;
};

export type AnnotationLabelingConfig = {
  /** Off by default: opt in only where Grafana annotation RBAC is verified. */
  enabled: boolean;
  /** Suggested categories; users can enter values outside this list. */
  categories: string[];
};

export type ClusterProfile = {
  id: string;
  displayName: string;
  connectionId: string;
  slurmClusterName: string;
  metricsDatasourceUid: string;
  metricsType?: 'prometheus' | 'victoriametrics';
  aggregationNodeLabels?: string[];
  instanceLabel?: string;
  nodeMatcherMode?: 'host:port' | 'hostname';
  defaultTemplateId?: string;
  metricsFilterLabel?: string;
  metricsFilterValue?: string;
  cpuUtilizationExpr?: string;
  gpuUtilizationExpr?: string;
  /** Job efficiency scorecard settings; unset fields use the defaults. */
  efficiency?: EfficiencySettings;
  accessRule?: AccessRule;
};

export type AccessRule = {
  allowedRoles?: string[];
  allowedUsers?: string[];
};

export type JsonData = {
  connections?: ConnectionProfile[];
  clusters?: ClusterProfile[];
  annotationLabeling?: AnnotationLabelingConfig;
  metricsifterServiceUrl?: string;
  metricsifterDefaultParams?: MetricSifterParams;
  metricsifterFilterGranularity?: FilterGranularity;
  defaultExportFolderUid?: string;
  dbHost?: string;
  dbName?: string;
  dbUser?: string;
  clusterName?: string;
  promDatasourceUid?: string;
  instanceLabel?: string;
};

export type ConnectionFormState = ConnectionProfile & {
  password: string;
  isPasswordConfigured: boolean;
};
