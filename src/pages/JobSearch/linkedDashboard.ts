import { JobRecord, LinkedDashboardSummary } from '../../api/types';

export const LINKED_DASHBOARD_TAG = 'slurm-job-link';

export function sortLinkedDashboards(dashboards: LinkedDashboardSummary[], preferredUid: string | null): LinkedDashboardSummary[] {
  return [...dashboards].sort((left, right) => {
    if (preferredUid) {
      if (left.uid === preferredUid && right.uid !== preferredUid) {
        return -1;
      }
      if (right.uid === preferredUid && left.uid !== preferredUid) {
        return 1;
      }
    }

    return left.title.localeCompare(right.title);
  });
}

export function buildLinkedDashboardUrl(baseUrl: string, job: JobRecord, nowMs = Date.now()): string {
  const url = new URL(baseUrl, window.location.origin);
  const searchParams = url.searchParams;
  const endTimeMs = job.endTime > 0 ? job.endTime * 1000 : nowMs;

  searchParams.set('from', String(job.startTime * 1000));
  searchParams.set('to', String(endTimeMs));
  searchParams.set('var-slurm_cluster_id', job.clusterId);
  searchParams.set('var-slurm_job_id', String(job.jobId));
  searchParams.set('var-slurm_job_name', job.name);
  searchParams.set('var-slurm_user', job.user);
  searchParams.set('var-slurm_account', job.account);
  searchParams.set('var-slurm_partition', job.partition);
  searchParams.set('var-slurm_state', job.state);
  searchParams.set('var-slurm_node_count', String(job.nodeCount));
  searchParams.set('var-slurm_gpu_count', String(job.gpusTotal));
  searchParams.set('var-slurm_nodes_csv', job.nodes.join(','));
  searchParams.delete('var-slurm_node');
  for (const node of job.nodes) {
    searchParams.append('var-slurm_node', node);
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

export function navigateToLinkedDashboard(url: string) {
  window.location.assign(url);
}
