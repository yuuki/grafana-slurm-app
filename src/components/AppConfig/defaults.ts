import { AnnotationLabelingConfig, ClusterProfile, ConnectionFormState, ConnectionProfile } from './types';

/** Default TSFM event-type vocabulary (design §4). */
export const DEFAULT_EVENT_TYPES = [
  'thermal_throttle',
  'nccl_stall',
  'job_failure',
  'perf_anomaly',
  'network_degradation',
  'other',
];

export const ANNOTATION_LABELING_DEFAULTS: AnnotationLabelingConfig = {
  enabled: false,
  eventTypes: DEFAULT_EVENT_TYPES,
  defaultQuality: 'candidate',
};

let nextId = 0;
function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++nextId}`;
}

export const CONNECTION_DEFAULTS: Omit<ConnectionProfile, 'id' | 'dbUser' | 'securePasswordRef'> = {
  dbHost: '',
  dbName: 'slurm_acct_db',
};

export const CLUSTER_DEFAULTS: Omit<ClusterProfile, 'id' | 'displayName' | 'connectionId' | 'slurmClusterName' | 'metricsDatasourceUid'> = {
  metricsType: 'prometheus',
  aggregationNodeLabels: ['host.name', 'instance'],
  instanceLabel: 'instance',
  nodeMatcherMode: 'host:port',
  defaultTemplateId: 'overview',
  metricsFilterLabel: '',
  metricsFilterValue: '',
  cpuUtilizationExpr: '',
  gpuUtilizationExpr: '',
};

export function newConnection(): ConnectionFormState {
  const id = generateId('conn');
  return {
    id,
    dbHost: '',
    dbName: 'slurm_acct_db',
    dbUser: '',
    securePasswordRef: `password-${id}`,
    password: '',
    isPasswordConfigured: false,
  };
}

export function newCluster(connectionId: string): ClusterProfile {
  const id = generateId('cluster');
  return {
    id,
    displayName: '',
    connectionId,
    slurmClusterName: '',
    metricsDatasourceUid: '',
    ...CLUSTER_DEFAULTS,
  };
}
