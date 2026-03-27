import { buildFilterMatcher, buildInstanceMatcher, getJobTimeSettings } from './model';
import { JobRecord } from '../../../api/types';

describe('job dashboard scene model', () => {
  const baseJob: JobRecord = {
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

  it('builds host:port matcher by default', () => {
    expect(buildInstanceMatcher(baseJob.nodes, 'instance', 'host:port')).toBe('instance=~"(gpu-node001|gpu-node002):[0-9]+"');
  });

  it('builds hostname matcher without exporter port suffix', () => {
    expect(buildInstanceMatcher(baseJob.nodes, 'instance', 'hostname')).toBe('instance=~"(gpu-node001|gpu-node002)"');
  });

  it('escapes regex metacharacters in node names for host:port matchers', () => {
    expect(buildInstanceMatcher(['gpu.node(001)', 'gpu-node[002]'], 'instance', 'host:port')).toBe(
      'instance=~"(gpu\\.node\\(001\\)|gpu-node\\[002\\]):[0-9]+"'
    );
  });

  it('normalizes dotted label names for PromQL matchers', () => {
    expect(buildInstanceMatcher(['gpu-node001'], 'host.name', 'hostname')).toBe('"host.name"=~"(gpu-node001)"');
    expect(buildFilterMatcher('k8s.cluster.name', 'slurm-a100')).toBe('"k8s.cluster.name"="slurm-a100"');
  });

  it('keeps dotted label names bare for VictoriaMetrics matchers', () => {
    expect(buildInstanceMatcher(['gpu-node001'], 'host.name', 'hostname', 'victoriametrics')).toBe(
      'host.name=~"(gpu-node001)"'
    );
    expect(buildFilterMatcher('k8s.cluster.name', 'slurm-a100', 'victoriametrics')).toBe(
      'k8s.cluster.name="slurm-a100"'
    );
  });

  it('uses now and refresh intervals for running jobs', () => {
    expect(getJobTimeSettings(baseJob)).toEqual({
      from: '2023-11-14T22:13:20.000Z',
      to: 'now',
      refreshIntervals: ['10s', '30s', '1m', '5m'],
    });
  });

  it('pins the end time for completed jobs', () => {
    const completedJob: JobRecord = { ...baseJob, state: 'COMPLETED', endTime: 1700003600 };

    expect(getJobTimeSettings(completedJob)).toEqual({
      from: '2023-11-14T22:13:20.000Z',
      to: '2023-11-14T23:13:20.000Z',
      refreshIntervals: [],
    });
  });
});
