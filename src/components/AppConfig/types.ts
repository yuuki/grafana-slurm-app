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
  nodeExporterPort?: string;
  dcgmExporterPort?: string;
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
  dbHost?: string;
  dbName?: string;
  dbUser?: string;
  clusterName?: string;
  promDatasourceUid?: string;
  nodeExporterPort?: string;
  dcgmExporterPort?: string;
  instanceLabel?: string;
};

export type ConnectionFormState = ConnectionProfile & {
  password: string;
  isPasswordConfigured: boolean;
};
