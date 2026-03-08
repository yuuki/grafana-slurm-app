import React from 'react';
import { AppPluginMeta } from '@grafana/data';
import { EmbeddedScene, SceneApp, SceneAppPage, SceneReactObject, useSceneApp } from '@grafana/scenes';
import { buildJobRoute, PLUGIN_BASE_URL, ROUTES } from '../constants';
import { JobSearchPage } from '../pages/JobSearch/JobSearchPage';
import { JobDashboardPage } from '../pages/JobDashboard/JobDashboardPage';

function wrapReactPage(component: React.ComponentType<any>, props: Record<string, unknown>) {
  return new EmbeddedScene({
    body: new SceneReactObject({
      component,
      props,
    }),
  });
}

function buildSceneApp(meta: AppPluginMeta) {
  const jobsPage = new SceneAppPage({
    title: 'Jobs',
    url: `${PLUGIN_BASE_URL}/${ROUTES.Jobs}`,
    routePath: `${PLUGIN_BASE_URL}/${ROUTES.Jobs}`,
    getScene: () => wrapReactPage(JobSearchPage, { meta }),
    drilldowns: [
      {
        routePath: `${PLUGIN_BASE_URL}/${ROUTES.Jobs}/:clusterId/:jobId`,
        getPage: (routeMatch, parent) =>
          new SceneAppPage({
            title: `Job ${routeMatch.params.jobId}`,
            url: buildJobRoute(routeMatch.params.clusterId, routeMatch.params.jobId),
            routePath: `${PLUGIN_BASE_URL}/${ROUTES.Jobs}/:clusterId/:jobId`,
            getParentPage: () => parent,
            getScene: () =>
              wrapReactPage(JobDashboardPage, {
                meta,
                clusterId: routeMatch.params.clusterId,
                jobId: routeMatch.params.jobId,
              }),
          }),
      },
    ],
  });

  return new SceneApp({
    name: 'Slurm Job Drilldown',
    pages: [jobsPage],
  });
}

export function AppSceneRoot({ meta }: { meta: AppPluginMeta }) {
  const app = useSceneApp(() => buildSceneApp(meta));
  const SceneAppComponent = app.Component;
  return <SceneAppComponent model={app} />;
}
