import type { FilterGranularity, MetricSifterParams } from '../../api/types';

export type ConnectionProfile = {
  id: string;
  dbHost: string;
  dbName?: string;
  dbUser: string;
  securePasswordRef: string;
};

export type TsfmQuality = 'candidate' | 'confirmed';

export type AnnotationLabelingConfig = {
  /** Off by default: opt in only where core annotation RBAC is verified. */
  enabled: boolean;
  /** Default event-type vocabulary; operators can extend it. */
  eventTypes: string[];
  defaultQuality: TsfmQuality;
};

export type ClusterProfile = {
  id: string;
  displayName: string;
  connectionId: string;
  slurmClusterName: string;
  metricsDatasourceUid: string;
  /** Canonical TSFM cluster id (e.g. isk | osk) written into `tsfm:cluster=`. */
  tsfmClusterId?: string;
  metricsType?: 'prometheus' | 'victoriametrics';
  aggregationNodeLabels?: string[];
  instanceLabel?: string;
  nodeMatcherMode?: 'host:port' | 'hostname';
  defaultTemplateId?: string;
  metricsFilterLabel?: string;
  metricsFilterValue?: string;
  cpuUtilizationExpr?: string;
  gpuUtilizationExpr?: string;
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
