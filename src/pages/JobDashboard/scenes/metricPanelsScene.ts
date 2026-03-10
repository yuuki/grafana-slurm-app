import {
  SceneFlexItem,
  SceneFlexLayout,
  SceneQueryRunner,
  VizPanel,
} from '@grafana/scenes';
import { ClusterSummary, JobRecord } from '../../../api/types';
import { buildFilterMatcher, buildInstanceMatcher } from './model';
import { getJobMetricDefinition } from './metricsCatalog';

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size));
  }
  return rows;
}

function buildMatchers(job: JobRecord, cluster: ClusterSummary) {
  const filterMatcher = buildFilterMatcher(cluster.metricsFilterLabel, cluster.metricsFilterValue);
  const filterSuffix = filterMatcher ? `,${filterMatcher}` : '';

  return {
    node: buildInstanceMatcher(job.nodes, cluster.instanceLabel, cluster.nodeExporterPort, cluster.nodeMatcherMode) + filterSuffix,
    gpu: buildInstanceMatcher(job.nodes, cluster.instanceLabel, cluster.dcgmExporterPort, cluster.nodeMatcherMode) + filterSuffix,
  };
}

function buildMetricQueryRunner(metricId: string, job: JobRecord, cluster: ClusterSummary): SceneQueryRunner | null {
  const metric = getJobMetricDefinition(metricId);
  if (!metric) {
    return null;
  }

  const matchers = buildMatchers(job, cluster);
  const matcher = metric.matcherKind === 'gpu' ? matchers.gpu : matchers.node;

  return new SceneQueryRunner({
    datasource: { type: cluster.metricsType, uid: cluster.metricsDatasourceUid },
    queries: [
      {
        refId: 'A',
        expr: metric.buildExpr(matcher, cluster.instanceLabel),
        legendFormat: metric.legendFormat,
      },
    ],
  });
}

function buildMetricPanel(metricId: string, job: JobRecord, cluster: ClusterSummary): SceneFlexItem | null {
  const metric = getJobMetricDefinition(metricId);
  const runner = buildMetricQueryRunner(metricId, job, cluster);
  if (!metric || !runner) {
    return null;
  }

  return new SceneFlexItem({
    body: new VizPanel({
      pluginId: 'timeseries',
      title: metric.title,
      $data: runner,
      fieldConfig: {
        defaults: metric.fieldConfig.defaults,
        overrides: metric.fieldConfig.overrides,
      },
    }),
  });
}

export function buildSelectedMetricPanels(job: JobRecord, cluster: ClusterSummary, selectedMetricIds: string[]): SceneFlexLayout {
  const panels = selectedMetricIds
    .map((metricId) => buildMetricPanel(metricId, job, cluster))
    .filter((panel): panel is SceneFlexItem => panel !== null);

  return new SceneFlexLayout({
    direction: 'column',
    children: chunk(panels, 2).map(
      (rowPanels) =>
        new SceneFlexLayout({
          direction: 'row',
          height: 300,
          children: rowPanels,
        })
    ),
  });
}
