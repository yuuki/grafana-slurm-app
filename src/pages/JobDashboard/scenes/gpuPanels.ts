import {
  SceneFlexLayout,
  SceneFlexItem,
  SceneQueryRunner,
  VizPanel,
} from '@grafana/scenes';
import { ThresholdsMode } from '@grafana/data';

function gpuQuery(promUid: string, instanceLabel: string, expr: string): SceneQueryRunner {
  return new SceneQueryRunner({
    datasource: { type: 'prometheus', uid: promUid },
    queries: [
      {
        refId: 'A',
        expr,
        legendFormat: `{{${instanceLabel}}} / GPU {{gpu}}`,
      },
    ],
  });
}

export function buildGpuPanels(promUid: string, instanceLabel: string): SceneFlexLayout {
  const il = instanceLabel;
  const matchExpr = '$gpuMatcher';

  return new SceneFlexLayout({
    direction: 'column',
    children: [
      // Row 1: GPU Utilization + GPU Memory
      new SceneFlexLayout({
        direction: 'row',
        height: 300,
        children: [
          new SceneFlexItem({
            body: new VizPanel({
              pluginId: 'timeseries',
              title: 'GPU Utilization',
              $data: gpuQuery(promUid, il,`DCGM_FI_DEV_GPU_UTIL{${matchExpr}}`),
              fieldConfig: {
                defaults: { unit: 'percent', min: 0, max: 100 },
                overrides: [],
              },
            }),
          }),
          new SceneFlexItem({
            body: new VizPanel({
              pluginId: 'timeseries',
              title: 'GPU Memory Used',
              $data: gpuQuery(promUid, il,`DCGM_FI_DEV_FB_USED{${matchExpr}}`),
              fieldConfig: {
                defaults: { unit: 'decmbytes' },
                overrides: [],
              },
            }),
          }),
        ],
      }),
      // Row 2: GPU Temperature + Power
      new SceneFlexLayout({
        direction: 'row',
        height: 300,
        children: [
          new SceneFlexItem({
            body: new VizPanel({
              pluginId: 'timeseries',
              title: 'GPU Temperature',
              $data: gpuQuery(promUid, il,`DCGM_FI_DEV_GPU_TEMP{${matchExpr}}`),
              fieldConfig: {
                defaults: {
                  unit: 'celsius',
                  thresholds: {
                    mode: ThresholdsMode.Absolute,
                    steps: [
                      { color: 'green', value: -Infinity },
                      { color: 'orange', value: 75 },
                      { color: 'red', value: 85 },
                    ],
                  },
                },
                overrides: [],
              },
            }),
          }),
          new SceneFlexItem({
            body: new VizPanel({
              pluginId: 'timeseries',
              title: 'GPU Power Usage',
              $data: gpuQuery(promUid, il,`DCGM_FI_DEV_POWER_USAGE{${matchExpr}}`),
              fieldConfig: {
                defaults: { unit: 'watt' },
                overrides: [],
              },
            }),
          }),
        ],
      }),
      // Row 3: SM Clock + NVLink Bandwidth
      new SceneFlexLayout({
        direction: 'row',
        height: 300,
        children: [
          new SceneFlexItem({
            body: new VizPanel({
              pluginId: 'timeseries',
              title: 'SM Clock',
              $data: gpuQuery(promUid, il,`DCGM_FI_DEV_SM_CLOCK{${matchExpr}}`),
              fieldConfig: {
                defaults: { unit: 'hertz' },
                overrides: [],
              },
            }),
          }),
          new SceneFlexItem({
            body: new VizPanel({
              pluginId: 'timeseries',
              title: 'NVLink Bandwidth',
              $data: gpuQuery(promUid, il,`DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL{${matchExpr}}`),
              fieldConfig: {
                defaults: { unit: 'Bps' },
                overrides: [],
              },
            }),
          }),
        ],
      }),
    ],
  });
}
