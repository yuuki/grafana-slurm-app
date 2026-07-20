import { DataQuery, TimeRange } from '@grafana/data';
import {
  dataLayers,
  EmbeddedScene,
  SceneControlsSpacer,
  SceneDataLayerSet,
  SceneRefreshPicker,
  SceneTimePicker,
  SceneTimeRange,
} from '@grafana/scenes';
import { ClusterSummary, JobRecord } from '../../../api/types';
import { getJobTimeSettings } from './model';
import { MetricExplorerEntry } from './metricDiscovery';
import { buildSelectedMetricPanels, MetricDisplayMode } from './metricPanelsScene';

/** Built-in Grafana datasource used for annotation-by-tags queries. */
const GRAFANA_ANNOTATION_DATASOURCE = { uid: '-- Grafana --', type: 'grafana' } as const;

function buildJobAnnotationLayer(
  tags: string[],
  /** Called with the created layer instance so callers can trigger a re-fetch
   *  in place (via `.runLayer()`) without rebuilding the whole Scene. */
  onLayerCreated?: (layer: dataLayers.AnnotationsDataLayer) => void
): SceneDataLayerSet {
  const layer = new dataLayers.AnnotationsDataLayer({
    name: 'Job annotations',
    key: 'job-annotations',
    query: {
      name: 'Job annotations',
      datasource: GRAFANA_ANNOTATION_DATASOURCE,
      enable: true,
      hide: false,
      iconColor: 'yellow',
      // Match all supplied tags (AND); mirror the LabelList query. The
      // built-in Grafana annotation datasource reads these extra fields,
      // which are not part of the base DataQuery shape.
      target: { refId: 'Anno', type: 'tags', tags, matchAny: false, limit: 100 } as unknown as DataQuery,
    },
  });
  onLayerCreated?.(layer);
  return new SceneDataLayerSet({ layers: [layer] });
}

export function buildJobDashboardScene(
  job: JobRecord,
  cluster: ClusterSummary,
  selectedEntries: MetricExplorerEntry[] = [],
  displayMode: MetricDisplayMode = 'raw',
  selectedSeriesIds?: Set<string>,
  /** Copy the current values so panel zoom survives without sharing a Scene child. */
  timeRangeSnapshot?: Pick<TimeRange, 'from' | 'to'>,
  /** When set, overlay existing job annotations as regions. */
  annotationTags?: string[],
  /** Called with the created annotation layer instance so the caller can
   *  trigger a targeted re-fetch (via `.runLayer()`) after a label mutation,
   *  instead of forcing a full Scene rebuild. */
  onAnnotationLayerCreated?: (layer: dataLayers.AnnotationsDataLayer) => void
): EmbeddedScene {
  const timeSettings = getJobTimeSettings(job);
  const timeRange = timeRangeSnapshot
    ? new SceneTimeRange({ from: timeRangeSnapshot.from.toISOString(), to: timeRangeSnapshot.to.toISOString() })
    : new SceneTimeRange({ from: timeSettings.from, to: timeSettings.to });

  return new EmbeddedScene({
    $timeRange: timeRange,
    $data:
      annotationTags && annotationTags.length > 0
        ? buildJobAnnotationLayer(annotationTags, onAnnotationLayerCreated)
        : undefined,
    controls: [
      new SceneControlsSpacer(),
      new SceneTimePicker({ isOnCanvas: true }),
      ...(timeSettings.refreshIntervals.length > 0
        ? [new SceneRefreshPicker({ intervals: timeSettings.refreshIntervals, isOnCanvas: true })]
        : []),
    ],
    body: buildSelectedMetricPanels(job, cluster, selectedEntries, displayMode, selectedSeriesIds),
  });
}
