import {
  SceneFlexLayout,
  SceneFlexItem,
  SceneQueryRunner,
  VizPanel,
} from '@grafana/scenes';

function nodeQuery(promUid: string, instanceLabel: string, expr: string): SceneQueryRunner {
  return new SceneQueryRunner({
    datasource: { type: 'prometheus', uid: promUid },
    queries: [
      {
        refId: 'A',
        expr,
        legendFormat: `{{${instanceLabel}}}`,
      },
    ],
  });
}

export function buildCpuMemoryPanels(promUid: string, instanceLabel: string): SceneFlexLayout {
  const matchExpr = '$nodeMatcher';

  return new SceneFlexLayout({
    direction: 'column',
    children: [
      new SceneFlexLayout({
        direction: 'row',
        height: 300,
        children: [
          new SceneFlexItem({
            body: new VizPanel({
              pluginId: 'timeseries',
              title: 'CPU Utilization',
              $data: nodeQuery(
                promUid,
                instanceLabel,
                `100 - (avg by(${instanceLabel})(rate(node_cpu_seconds_total{mode="idle",${matchExpr}}[5m])) * 100)`
              ),
              fieldConfig: {
                defaults: { unit: 'percent', min: 0, max: 100 },
                overrides: [],
              },
            }),
          }),
          new SceneFlexItem({
            body: new VizPanel({
              pluginId: 'timeseries',
              title: 'Memory Usage',
              $data: nodeQuery(
                promUid,
                instanceLabel,
                `node_memory_MemTotal_bytes{${matchExpr}} - node_memory_MemAvailable_bytes{${matchExpr}}`
              ),
              fieldConfig: {
                defaults: { unit: 'bytes' },
                overrides: [],
              },
            }),
          }),
        ],
      }),
      new SceneFlexLayout({
        direction: 'row',
        height: 300,
        children: [
          new SceneFlexItem({
            body: new VizPanel({
              pluginId: 'timeseries',
              title: 'Load Average (15m)',
              $data: nodeQuery(
                promUid,
                instanceLabel,
                `node_load15{${matchExpr}}`
              ),
              fieldConfig: {
                defaults: {},
                overrides: [],
              },
            }),
          }),
          new SceneFlexItem({
            body: new VizPanel({
              pluginId: 'timeseries',
              title: 'Memory Utilization %',
              $data: nodeQuery(
                promUid,
                instanceLabel,
                `100 * (1 - node_memory_MemAvailable_bytes{${matchExpr}} / node_memory_MemTotal_bytes{${matchExpr}})`
              ),
              fieldConfig: {
                defaults: { unit: 'percent', min: 0, max: 100 },
                overrides: [],
              },
            }),
          }),
        ],
      }),
    ],
  });
}
