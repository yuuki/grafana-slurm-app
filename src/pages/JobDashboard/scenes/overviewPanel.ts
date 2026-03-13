import { SceneFlexLayout, SceneFlexItem, VizPanel, SceneDataNode } from '@grafana/scenes';
import { FieldType, LoadingState, MappingType, toDataFrame } from '@grafana/data';
import { SlurmJob } from '../../../api/types';
import { formatDuration } from '../../JobSearch/jobTime';

function staticData(displayText: string) {
  return new SceneDataNode({
    data: {
      series: [
        toDataFrame({
          fields: [
            {
              name: 'Value',
              type: FieldType.number,
              values: [1],
              config: {
                mappings: [{ type: MappingType.ValueToText, options: { '1': { text: displayText } } }],
              },
            },
          ],
        }),
      ],
      state: LoadingState.Done,
      timeRange: {} as any,
    },
  });
}

export function buildOverviewPanel(job: SlurmJob): SceneFlexLayout {
  const endTime = job.endTime > 0 ? job.endTime : Math.floor(Date.now() / 1000);
  const elapsed = endTime - job.startTime;

  const stats = [
    { label: 'Job ID', value: String(job.jobId) },
    { label: 'Name', value: job.name },
    { label: 'User', value: job.user },
    { label: 'Partition', value: job.partition },
    { label: 'State', value: job.state },
    { label: 'Nodes', value: String(job.nodeCount) },
    { label: 'GPUs', value: String(job.gpusTotal || '-') },
    { label: 'Elapsed', value: formatDuration(elapsed) },
  ];

  return new SceneFlexLayout({
    direction: 'row',
    children: stats.map(
      (s) =>
        new SceneFlexItem({
          body: new VizPanel({
            pluginId: 'stat',
            title: s.label,
            options: {
              textMode: 'value',
              colorMode: 'background',
              reduceOptions: { calcs: ['lastNotNull'], fields: '' },
            },
            fieldConfig: {
              defaults: {},
              overrides: [],
            },
            $data: staticData(s.value),
          }),
        })
    ),
  });
}
