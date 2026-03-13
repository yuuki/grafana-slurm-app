import {
  SceneDataTransformer,
  EmbeddedScene,
  SceneFlexItem,
  SceneFlexLayout,
  SceneQueryRunner,
  SceneTimeRange,
  VizPanel,
} from '@grafana/scenes';
import { DataFrame, Field, FieldConfigSource, FieldType, getFieldDisplayName } from '@grafana/data';
import { map } from 'rxjs/operators';
import { ClusterSummary, JobRecord } from '../../../api/types';
import { buildFilterMatcher, buildInstanceMatcher, getJobTimeSettings } from './model';
import { getMetricEntryByKey, MetricExplorerEntry } from './metricDiscovery';

export type MetricDisplayMode = 'raw';

function resolveLegendFormat(legendFormat: string, instanceLabel: string): string {
  return legendFormat.replaceAll('{{instance}}', `{{${instanceLabel}}}`);
}

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size));
  }
  return rows;
}

function buildMatcher(job: JobRecord, cluster: ClusterSummary) {
  const filterMatcher = buildFilterMatcher(cluster.metricsFilterLabel, cluster.metricsFilterValue, cluster.metricsType);
  const filterSuffix = filterMatcher ? `,${filterMatcher}` : '';

  return buildInstanceMatcher(job.nodes, cluster.instanceLabel, cluster.nodeMatcherMode, cluster.metricsType) + filterSuffix;
}

export function buildDashboardMetricQuery(entry: MetricExplorerEntry, _displayMode: MetricDisplayMode, job: JobRecord, cluster: ClusterSummary):
  | { title: string; expr: string; legendFormat: string; fieldConfig: Pick<FieldConfigSource, 'defaults' | 'overrides'> }
  | null {
  if (!entry.metricName) {
    return null;
  }
  const matcher = buildMatcher(job, cluster);

  return {
    title: entry.title,
    expr: `${entry.metricName}{${matcher}}`,
    legendFormat: resolveLegendFormat(entry.legendFormat, cluster.instanceLabel),
    fieldConfig: entry.fieldConfig,
  };
}

export function buildExploreMetricQuery(metricKey: string, job: JobRecord, cluster: ClusterSummary):
  | { title: string; expr: string; legendFormat: string; fieldConfig: Pick<FieldConfigSource, 'defaults' | 'overrides'> }
  | null {
  const metric = getMetricEntryByKey(metricKey);
  if (!metric) {
    return null;
  }

  const matcher = buildMatcher(job, cluster);

  return {
    title: metric.title,
    expr: metric.buildExpr(matcher),
    legendFormat: resolveLegendFormat(metric.legendFormat, cluster.instanceLabel),
    fieldConfig: metric.fieldConfig,
  };
}

function getLegendField(frame: DataFrame): Field | undefined {
  return frame.fields.find((field) => field.type !== FieldType.time) ?? frame.fields[0];
}

export function sortSeriesFramesByLegend(frames: DataFrame[]): DataFrame[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  return [...frames].sort((left, right) => {
    const leftField = getLegendField(left);
    const rightField = getLegendField(right);
    const leftLegend = leftField ? getFieldDisplayName(leftField, left) : left.name ?? '';
    const rightLegend = rightField ? getFieldDisplayName(rightField, right) : right.name ?? '';
    return collator.compare(leftLegend, rightLegend);
  });
}

function buildMetricPanel(entry: MetricExplorerEntry, displayMode: MetricDisplayMode, job: JobRecord, cluster: ClusterSummary): SceneFlexItem | null {
  const metricQuery = buildDashboardMetricQuery(entry, displayMode, job, cluster);
  if (!metricQuery) {
    return null;
  }

  const runner = new SceneQueryRunner({
    datasource: { type: cluster.metricsType, uid: cluster.metricsDatasourceUid },
    queries: [
      {
        refId: 'A',
        expr: metricQuery.expr,
        legendFormat: metricQuery.legendFormat,
      },
    ],
  });
  const dataProvider = new SceneDataTransformer({
    $data: runner,
    transformations: [
      () => (source) =>
        source.pipe(
          map((frames) => sortSeriesFramesByLegend(frames))
        ),
    ],
  });

  return new SceneFlexItem({
    body: new VizPanel({
      pluginId: 'timeseries',
      title: metricQuery.title,
      $data: dataProvider,
      fieldConfig: {
        defaults: metricQuery.fieldConfig.defaults,
        overrides: metricQuery.fieldConfig.overrides,
      },
    }),
  });
}

export function buildSelectedMetricPanels(
  job: JobRecord,
  cluster: ClusterSummary,
  selectedEntries: MetricExplorerEntry[],
  displayMode: MetricDisplayMode
): SceneFlexLayout {
  const panels = selectedEntries
    .map((entry) => buildMetricPanel(entry, displayMode, job, cluster))
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

export function buildMetricPreviewScene(
  job: JobRecord,
  cluster: ClusterSummary,
  entry: MetricExplorerEntry,
  displayMode: MetricDisplayMode
): EmbeddedScene | null {
  const panel = buildMetricPanel(entry, displayMode, job, cluster);
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
