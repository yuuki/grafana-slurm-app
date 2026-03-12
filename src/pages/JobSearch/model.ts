import { ListJobMetadataOptionsParams, ListJobsParams } from '../../api/types';

export interface SearchFilters {
  clusterId: string;
  jobId?: string;
  user?: string;
  account?: string;
  partition?: string;
  state?: string;
  name?: string;
}

export type MetadataField = 'name' | 'user' | 'account' | 'partition';

const METADATA_OPTIONS_LIMIT = 50;
export const JOBS_PAGE_SIZE = 100;

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

export function buildListJobsParams(filters: SearchFilters, options?: { cursor?: string }): ListJobsParams {
  return {
    clusterId: filters.clusterId,
    account: filters.account || undefined,
    user: filters.user || undefined,
    partition: filters.partition || undefined,
    state: filters.state || undefined,
    name: filters.name || undefined,
    limit: JOBS_PAGE_SIZE,
    cursor: options?.cursor,
  };
}

export function applyFilterValue(filters: SearchFilters, field: keyof SearchFilters, value: string): SearchFilters {
  if (field === 'clusterId' || field === 'jobId') {
    return { ...filters, [field]: value };
  }

  return {
    ...filters,
    jobId: '',
    [field]: value,
  };
}

export function buildListJobMetadataOptionsParams(
  filters: SearchFilters,
  field: MetadataField,
  query: string
): ListJobMetadataOptionsParams {
  return {
    clusterId: filters.clusterId,
    field,
    query: query || undefined,
    account: field === 'account' ? undefined : filters.account || undefined,
    user: field === 'user' ? undefined : filters.user || undefined,
    partition: field === 'partition' ? undefined : filters.partition || undefined,
    state: filters.state || undefined,
    name: field === 'name' ? undefined : filters.name || undefined,
    limit: METADATA_OPTIONS_LIMIT,
  };
}
