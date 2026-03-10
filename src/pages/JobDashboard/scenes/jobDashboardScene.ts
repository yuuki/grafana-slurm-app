import {
  EmbeddedScene,
  NestedScene,
  SceneControlsSpacer,
  SceneFlexItem,
  SceneFlexLayout,
  SceneRefreshPicker,
  SceneTimePicker,
  SceneTimeRange,
} from '@grafana/scenes';
import { ClusterSummary, JobRecord } from '../../../api/types';
import { buildCpuMemoryPanels } from './cpuMemoryPanels';
import { buildDiskPanels } from './diskPanels';
import { buildGpuPanels } from './gpuPanels';
import { buildFilterMatcher, buildInstanceMatcher, getJobTimeSettings } from './model';
import { buildNetworkPanels } from './networkPanels';
import { buildOverviewPanel } from './overviewPanel';

function templateLayout(templateId: string) {
  switch (templateId) {
    case 'inference':
      return { gpuCollapsed: false, cpuCollapsed: false, networkCollapsed: true, diskCollapsed: true };
    case 'distributed-training':
      return { gpuCollapsed: false, cpuCollapsed: true, networkCollapsed: false, diskCollapsed: true };
    default:
      return { gpuCollapsed: false, cpuCollapsed: true, networkCollapsed: true, diskCollapsed: true };
  }
}

export function buildJobDashboardScene(job: JobRecord, cluster: ClusterSummary): EmbeddedScene {
  const timeSettings = getJobTimeSettings(job);
  const layout = templateLayout(job.templateId);

  const filterMatcher = buildFilterMatcher(cluster.metricsFilterLabel, cluster.metricsFilterValue);
  const filterSuffix = filterMatcher ? `,${filterMatcher}` : '';
  const nodeMatcher = buildInstanceMatcher(job.nodes, cluster.instanceLabel, cluster.nodeExporterPort, cluster.nodeMatcherMode) + filterSuffix;
  const gpuMatcher = buildInstanceMatcher(job.nodes, cluster.instanceLabel, cluster.dcgmExporterPort, cluster.nodeMatcherMode) + filterSuffix;

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
        new NestedScene({
          title: 'GPU Metrics',
          isCollapsed: layout.gpuCollapsed,
          body: buildGpuPanels(cluster.metricsDatasourceUid, cluster.instanceLabel, gpuMatcher),
        }),
        new NestedScene({
          title: 'CPU / Memory',
          isCollapsed: layout.cpuCollapsed,
          body: buildCpuMemoryPanels(cluster.metricsDatasourceUid, cluster.instanceLabel, nodeMatcher),
        }),
        new NestedScene({
          title: 'Network / InfiniBand',
          isCollapsed: layout.networkCollapsed,
          body: buildNetworkPanels(cluster.metricsDatasourceUid, cluster.instanceLabel, nodeMatcher),
        }),
        new NestedScene({
          title: 'Disk I/O',
          isCollapsed: layout.diskCollapsed,
          body: buildDiskPanels(cluster.metricsDatasourceUid, cluster.instanceLabel, nodeMatcher),
        }),
      ],
    }),
  });
}
