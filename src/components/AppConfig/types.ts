import type { FilterGranularity, MetricSifterParams } from '../../api/types';

export type ConnectionProfile = {
  id: string;
  dbHost: string;
  dbName?: string;
  dbUser: string;
  securePasswordRef: string;
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
  accessRule?: AccessRule;
};

export type AccessRule = {
  allowedRoles?: string[];
  allowedUsers?: string[];
};

export type JsonData = {
  connections?: ConnectionProfile[];
  clusters?: ClusterProfile[];
  metricsifterServiceUrl?: string;
  metricsifterDefaultParams?: MetricSifterParams;
  metricsifterFilterGranularity?: FilterGranularity;
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
