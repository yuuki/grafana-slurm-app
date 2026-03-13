import {
  EmbeddedScene,
  SceneControlsSpacer,
  SceneRefreshPicker,
  SceneTimePicker,
  SceneTimeRange,
} from '@grafana/scenes';
import { ClusterSummary, JobRecord } from '../../../api/types';
import { getJobTimeSettings } from './model';
import { MetricExplorerEntry } from './metricDiscovery';
import { buildSelectedMetricPanels, MetricDisplayMode } from './metricPanelsScene';

export function buildJobDashboardScene(
  job: JobRecord,
  cluster: ClusterSummary,
  selectedEntries: MetricExplorerEntry[] = [],
  displayMode: MetricDisplayMode = 'raw'
): EmbeddedScene {
  const timeSettings = getJobTimeSettings(job);

  return new EmbeddedScene({
    $timeRange: new SceneTimeRange({ from: timeSettings.from, to: timeSettings.to }),
    controls: [
      new SceneControlsSpacer(),
      new SceneTimePicker({ isOnCanvas: true }),
      ...(timeSettings.refreshIntervals.length > 0
        ? [new SceneRefreshPicker({ intervals: timeSettings.refreshIntervals, isOnCanvas: true })]
        : []),
    ],
    body: buildSelectedMetricPanels(job, cluster, selectedEntries, displayMode),
  });
}
