import { getBackendSrv } from '@grafana/runtime';
import { PLUGIN_ID } from '../constants';
import {
  GrafanaDashboard,
  JobRecord,
  ListClustersResponse,
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

export async function searchGrafanaDashboards(): Promise<GrafanaDashboard[]> {
  const results: any[] = await getBackendSrv().get('/api/search', { type: 'dash-db', limit: 200 });
  return results.map((d) => ({
    uid: d.uid as string,
    title: d.title as string,
    url: d.url as string,
    folderTitle: d.folderTitle as string | undefined,
  }));
}
