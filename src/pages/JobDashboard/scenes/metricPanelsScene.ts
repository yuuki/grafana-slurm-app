import {
  EmbeddedScene,
  SceneFlexItem,
  SceneFlexLayout,
  SceneQueryRunner,
  SceneTimeRange,
  VizPanel,
} from '@grafana/scenes';
import { FieldConfigSource } from '@grafana/data';
import { ClusterSummary, JobRecord } from '../../../api/types';
import { buildFilterMatcher, buildInstanceMatcher, getJobTimeSettings } from './model';
import { getMetricEntryByKey } from './metricDiscovery';

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

export function buildMetricQuery(metricKey: string, job: JobRecord, cluster: ClusterSummary):
  | { title: string; expr: string; legendFormat: string; fieldConfig: Pick<FieldConfigSource, 'defaults' | 'overrides'> }
  | null {
  const metric = getMetricEntryByKey(metricKey);
  if (!metric) {
    return null;
  }

  const matchers = buildMatchers(job, cluster);
  const matcher = metric.matcherKind === 'gpu' ? matchers.gpu : matchers.node;

  return {
    title: metric.title,
    expr: metric.buildExpr(matcher, cluster.instanceLabel),
    legendFormat: metric.legendFormat,
    fieldConfig: metric.fieldConfig,
  };
}

function buildMetricQueryRunner(metricKey: string, job: JobRecord, cluster: ClusterSummary): SceneQueryRunner | null {
  const metricQuery = buildMetricQuery(metricKey, job, cluster);
  if (!metricQuery) {
    return null;
  }

  return new SceneQueryRunner({
    datasource: { type: cluster.metricsType, uid: cluster.metricsDatasourceUid },
    queries: [
      {
        refId: 'A',
        expr: metricQuery.expr,
        legendFormat: metricQuery.legendFormat,
      },
    ],
  });
}

function buildMetricPanel(metricId: string, job: JobRecord, cluster: ClusterSummary): SceneFlexItem | null {
  const metric = buildMetricQuery(metricId, job, cluster);
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

export function buildMetricPreviewScene(job: JobRecord, cluster: ClusterSummary, metricKey: string): EmbeddedScene | null {
  const panel = buildMetricPanel(metricKey, job, cluster);
  if (!panel) {
    return null;
  }

  const timeSettings = getJobTimeSettings(job);

  return new EmbeddedScene({
    $timeRange: new SceneTimeRange({ from: timeSettings.from, to: timeSettings.to }),
    body: new SceneFlexLayout({
      direction: 'column',
      children: [
        new SceneFlexLayout({
          direction: 'row',
          height: 220,
          children: [panel],
        }),
      ],
    }),
  });
}
