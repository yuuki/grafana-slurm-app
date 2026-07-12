export interface NodeHealthCluster {
  id: string;
  name: string;
}

export interface NodeHealthWindow {
  from: number;
  to: number;
}

export interface NodeHealthBaseline {
  totalJobs: number;
  failedJobs: number;
  failureRate: number;
}

export interface NodeHealthStats {
  name: string;
  totalJobs: number;
  failedJobs: number;
  nodeFailJobs: number;
  failedNodeHits: number;
  failureRate: number;
  expectedFailures: number;
  score: number;
  lastFailureAt?: number;
  lowSample: boolean;
}

export interface NodeHealthPayload {
  cluster: NodeHealthCluster;
  window: NodeHealthWindow;
  baseline: NodeHealthBaseline;
  truncated: boolean;
  nodes: NodeHealthStats[];
}
