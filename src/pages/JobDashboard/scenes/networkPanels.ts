import {
  SceneFlexLayout,
  SceneFlexItem,
  SceneQueryRunner,
  VizPanel,
} from '@grafana/scenes';

function netQuery(promUid: string, expr: string, legend: string): SceneQueryRunner {
  return new SceneQueryRunner({
    datasource: { type: 'prometheus', uid: promUid },
    queries: [
      {
        refId: 'A',
        expr,
        legendFormat: legend,
      },
    ],
  });
}

export function buildNetworkPanels(promUid: string, instanceLabel: string, matcher: string): SceneFlexLayout {
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
              title: 'Network Receive',
              $data: netQuery(
                promUid,
                `rate(node_network_receive_bytes_total{device!="lo",${matcher}}[5m])`,
                `{{${instanceLabel}}} {{device}}`
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
              title: 'Network Transmit',
              $data: netQuery(
                promUid,
                `rate(node_network_transmit_bytes_total{device!="lo",${matcher}}[5m])`,
                `{{${instanceLabel}}} {{device}}`
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
              title: 'InfiniBand Receive',
              $data: netQuery(
                promUid,
                `rate(node_infiniband_port_data_received_bytes_total{${matcher}}[5m])`,
                `{{${instanceLabel}}} {{device}}`
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
              title: 'InfiniBand Transmit',
              $data: netQuery(
                promUid,
                `rate(node_infiniband_port_data_transmitted_bytes_total{${matcher}}[5m])`,
                `{{${instanceLabel}}} {{device}}`
              ),
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
