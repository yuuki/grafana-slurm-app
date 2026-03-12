import { getBackendSrv } from '@grafana/runtime';
import { PLUGIN_ID } from '../constants';
import {
  JobRecord,
  LinkedDashboardSummary,
  ListClustersResponse,
  ListJobMetadataOptionsParams,
  ListJobMetadataOptionsResponse,
  ListJobsParams,
  ListJobsResponse,
  ListTemplatesResponse,
} from './types';

const BASE_URL = `/api/plugins/${PLUGIN_ID}/resources`;

export async function listClusters(): Promise<ListClustersResponse> {
  return getBackendSrv().get(`${BASE_URL}/api/clusters`);
}

export async function listTemplates(): Promise<ListTemplatesResponse> {
  return getBackendSrv().get(`${BASE_URL}/api/templates`);
}

export async function listJobs(params: ListJobsParams): Promise<ListJobsResponse> {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '') {
      searchParams.set(key, String(value));
    }
  });

  const query = searchParams.toString();
  const url = `${BASE_URL}/api/jobs${query ? `?${query}` : ''}`;

  return getBackendSrv().get(url);
}

export async function listJobMetadataOptions(params: ListJobMetadataOptionsParams): Promise<ListJobMetadataOptionsResponse> {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '') {
      searchParams.set(key, String(value));
    }
  });

  const query = searchParams.toString();
  const url = `${BASE_URL}/api/jobs/metadata/options${query ? `?${query}` : ''}`;

  return getBackendSrv().get(url);
}

export async function getJob(clusterId: string, jobId: number | string, template?: string): Promise<JobRecord> {
  const searchParams = new URLSearchParams();
  if (template) {
    searchParams.set('template', template);
  }
  const query = searchParams.toString();
  const url = `${BASE_URL}/api/jobs/${clusterId}/${jobId}${query ? `?${query}` : ''}`;
  return getBackendSrv().get(url);
}

export async function exportDashboard(payload: { clusterId: string; jobId: number; template?: string }) {
  return getBackendSrv().post(`${BASE_URL}/api/dashboards/export`, payload);
}

interface DashboardSearchResult {
  uid?: string;
  title?: string;
  url?: string;
  tags?: unknown;
}

export async function listLinkableDashboards(tag: string): Promise<LinkedDashboardSummary[]> {
  const searchParams = new URLSearchParams({
    type: 'dash-db',
    tag,
  });

  const results = await getBackendSrv().get<DashboardSearchResult[]>(`/api/search?${searchParams.toString()}`);

  return results
    .filter((result): result is Required<Pick<DashboardSearchResult, 'uid' | 'title' | 'url'>> & DashboardSearchResult => {
      return typeof result.uid === 'string' && typeof result.title === 'string' && typeof result.url === 'string';
    })
    .map((result) => ({
      uid: result.uid,
      title: result.title,
      url: result.url,
      tags: Array.isArray(result.tags) ? result.tags.filter((tagItem): tagItem is string => typeof tagItem === 'string') : [],
    }));
}
