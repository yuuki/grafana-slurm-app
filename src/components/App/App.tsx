import React from 'react';
import { AppRootProps } from '@grafana/data';
import { PLUGIN_ID } from '../../constants';
import { JobDashboardPage } from '../../pages/JobDashboard/JobDashboardPage';
import { JobSearchPage } from '../../pages/JobSearch/JobSearchPage';

function matchDashboardPath(pathname: string): { clusterId: string; jobId: string } | null {
  const patterns = [
    new RegExp(`^/a/${PLUGIN_ID}/jobs/([^/]+)/([^/]+)$`),
    new RegExp(`^/plugins/${PLUGIN_ID}/page/job-search/([^/]+)/([^/]+)$`),
  ];

  for (const pattern of patterns) {
    const match = pathname.match(pattern);
    if (match) {
      return { clusterId: match[1], jobId: match[2] };
    }
  }

  return null;
}

export function App(props: AppRootProps) {
  const { meta } = props;
  const dashboardRoute = matchDashboardPath(window.location.pathname.replace(/\/+$/, ''));

  if (dashboardRoute) {
    return <JobDashboardPage meta={meta} clusterId={dashboardRoute.clusterId} jobId={dashboardRoute.jobId} />;
  }

  return <JobSearchPage />;
}
