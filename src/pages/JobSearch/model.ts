import { ListJobsParams } from '../../api/types';

export interface SearchFilters {
  clusterId: string;
  jobId?: string;
  user?: string;
  account?: string;
  partition?: string;
  state?: string;
  name?: string;
}

export function canLookupJob(filters: Pick<SearchFilters, 'clusterId' | 'jobId'>): boolean {
  return Boolean(filters.clusterId && filters.jobId);
}

export function getNextClusterId(clusters: Array<{ id: string }>, currentClusterId: string): string {
  if (clusters.length === 0) {
    return currentClusterId;
  }

  return clusters.some((cluster) => cluster.id === currentClusterId) ? currentClusterId : clusters[0].id;
}

export function buildAutoSearchFilters(filters: Pick<SearchFilters, 'clusterId'>): SearchFilters {
  return {
    clusterId: filters.clusterId,
    jobId: '',
    name: '',
    user: '',
    account: '',
    partition: '',
    state: '',
  };
}

export function buildListJobsParams(filters: SearchFilters): ListJobsParams {
  return {
    clusterId: filters.clusterId,
    account: filters.account || undefined,
    user: filters.user || undefined,
    partition: filters.partition || undefined,
    state: filters.state || undefined,
    name: filters.name || undefined,
    limit: 100,
  };
}
