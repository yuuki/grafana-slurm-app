import {
  EmbeddedScene,
  SceneControlsSpacer,
  SceneFlexItem,
  SceneFlexLayout,
  SceneRefreshPicker,
  SceneTimePicker,
  SceneTimeRange,
} from '@grafana/scenes';
import { ClusterSummary, JobRecord } from '../../../api/types';
import { getJobTimeSettings } from './model';
import { buildSelectedMetricPanels } from './metricPanelsScene';
import { buildOverviewPanel } from './overviewPanel';

export function buildJobDashboardScene(
  job: JobRecord,
  cluster: ClusterSummary,
  selectedMetricIds: string[] = []
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
    body: new SceneFlexLayout({
      direction: 'column',
      children: [
        new SceneFlexItem({
          height: 120,
          body: buildOverviewPanel(job),
        }),
        new SceneFlexItem({
          body: buildSelectedMetricPanels(job, cluster, selectedMetricIds),
        }),
      ],
    }),
  });
}
