import { DataQuery } from '@grafana/data';
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
const GRAFANA_ANNOTATION_DATASOURCE = { uid: '-- Grafana --', type: 'datasource' } as const;

function buildTsfmAnnotationLayer(
  tags: string[],
  /** Called with the created layer instance so callers can trigger a re-fetch
   *  in place (via `.runLayer()`) without rebuilding the whole Scene. */
  onLayerCreated?: (layer: dataLayers.AnnotationsDataLayer) => void
): SceneDataLayerSet {
  const layer = new dataLayers.AnnotationsDataLayer({
    name: 'TSFM labels',
    key: 'tsfm-labels',
    query: {
      name: 'TSFM labels',
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
  /** Reuse an existing time range so panel zoom survives Scene rebuilds. */
  existingTimeRange?: SceneTimeRange,
  /** When set, overlay existing TSFM labels as region annotations. */
  annotationTags?: string[],
  /** Called with the created annotation layer instance so the caller can
   *  trigger a targeted re-fetch (via `.runLayer()`) after a label mutation,
   *  instead of forcing a full Scene rebuild. */
  onAnnotationLayerCreated?: (layer: dataLayers.AnnotationsDataLayer) => void
): EmbeddedScene {
  const timeSettings = getJobTimeSettings(job);

  return new EmbeddedScene({
    $timeRange: existingTimeRange ?? new SceneTimeRange({ from: timeSettings.from, to: timeSettings.to }),
    $data:
      annotationTags && annotationTags.length > 0
        ? buildTsfmAnnotationLayer(annotationTags, onAnnotationLayerCreated)
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
