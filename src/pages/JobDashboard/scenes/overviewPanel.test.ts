import { createTheme, FieldType, getDisplayProcessor, ReducerID, reduceField } from '@grafana/data';
import { SceneDataNode, SceneFlexItem, VizPanel } from '@grafana/scenes';
import { JobRecord } from '../../../api/types';
import { buildOverviewPanel } from './overviewPanel';

describe('buildOverviewPanel', () => {
  const job: JobRecord = {
    clusterId: 'a100',
    jobId: 10001,
    name: 'train_llm',
    user: 'researcher1',
    account: 'ml-team',
    partition: 'gpu-a100',
    state: 'RUNNING',
    nodes: ['gpu-node001', 'gpu-node002'],
    nodeList: 'gpu-node[001-002]',
    nodeCount: 2,
    gpusTotal: 16,
    submitTime: 1699999700,
    startTime: 1700000000,
    endTime: 0,
    exitCode: 0,
    workDir: '/tmp',
    tres: '1001=gres/gpu:16',
    templateId: 'distributed-training',
  };

  it('renders string stat values through a reducible numeric field', () => {
    const layout = buildOverviewPanel(job);
    const items = layout.state.children as SceneFlexItem[];
    const namePanel = items.find((item) => (item.state.body as VizPanel).state.title === 'Name')?.state.body as VizPanel;
    const dataNode = namePanel.state.$data as SceneDataNode;
    const valueField = dataNode.state.data.series[0].fields[0];

    expect(valueField.type).toBe(FieldType.number);
    expect(namePanel.state.options).toMatchObject({
      textMode: 'value',
      reduceOptions: { calcs: ['lastNotNull'], fields: '' },
    });

    valueField.display = getDisplayProcessor({ field: valueField, theme: createTheme() });
    const reduced = reduceField({ field: valueField, reducers: [ReducerID.lastNotNull] });

    expect(valueField.display(reduced[ReducerID.lastNotNull]).text).toBe('train_llm');
  });
});
