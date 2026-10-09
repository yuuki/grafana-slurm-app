import { buildCompareRoute, buildJobRoute } from '../../constants';

export function navigateToJobPage(clusterId: string, jobId: number | string) {
  window.location.assign(buildJobRoute(clusterId, jobId));
}

export function navigateToLinkedDashboard(url: string) {
  window.location.assign(url);
}

export function navigateToComparePage(params: URLSearchParams) {
  window.location.assign(buildCompareRoute(params));
}
