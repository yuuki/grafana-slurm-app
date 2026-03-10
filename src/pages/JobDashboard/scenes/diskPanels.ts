import {
  SceneFlexLayout,
  SceneFlexItem,
  SceneQueryRunner,
  VizPanel,
} from '@grafana/scenes';

function diskQuery(promUid: string, instanceLabel: string, expr: string): SceneQueryRunner {
  return new SceneQueryRunner({
    datasource: { type: 'prometheus', uid: promUid },
    queries: [
      {
        refId: 'A',
        expr,
        legendFormat: `{{${instanceLabel}}} {{device}}`,
      },
    ],
  });
}

export function buildDiskPanels(promUid: string, instanceLabel: string, matcher: string): SceneFlexLayout {
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
              title: 'Disk Read',
              $data: diskQuery(
                promUid,
                instanceLabel,
                `rate(node_disk_read_bytes_total{${matcher}}[5m])`
              ),
              fieldConfig: {
                defaults: { unit: 'Bps' },
                overrides: [],
              },
            }),
          }),
          new SceneFlexItem({
            body: new VizPanel({
              pluginId: 'timeseries',
              title: 'Disk Write',
              $data: diskQuery(
                promUid,
                instanceLabel,
                `rate(node_disk_written_bytes_total{${matcher}}[5m])`
              ),
              fieldConfig: {
                defaults: { unit: 'Bps' },
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
              title: 'Disk Read IOPS',
              $data: diskQuery(
                promUid,
                instanceLabel,
                `rate(node_disk_reads_completed_total{${matcher}}[5m])`
              ),
              fieldConfig: {
                defaults: { unit: 'iops' },
                overrides: [],
              },
            }),
          }),
          new SceneFlexItem({
            body: new VizPanel({
              pluginId: 'timeseries',
              title: 'Disk Write IOPS',
              $data: diskQuery(
                promUid,
                instanceLabel,
                `rate(node_disk_writes_completed_total{${matcher}}[5m])`
              ),
              fieldConfig: {
                defaults: { unit: 'iops' },
                overrides: [],
              },
            }),
          }),
        ],
      }),
    ],
  });
}
