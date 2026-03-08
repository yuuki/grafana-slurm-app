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
