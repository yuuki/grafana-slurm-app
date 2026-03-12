import { buildJobRoute } from '../../constants';

export function navigateToJobPage(clusterId: string, jobId: number | string) {
  window.location.assign(buildJobRoute(clusterId, jobId));
}

export function navigateToLinkedDashboard(url: string) {
  window.location.assign(url);
}
