import { buildFilterMatcher, buildInstanceMatcher, escapePromRegex, getJobTimeSettings } from './model';
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
    // A PromQL string literal reads a backslash as an escape, so each regex
    // escape is written as two backslashes inside the double quotes.
    expect(buildInstanceMatcher(['gpu.node(001)', 'gpu-node[002]'], 'instance', 'host:port')).toBe(
      String.raw`instance=~"(gpu\\.node\\(001\\)|gpu-node\\[002\\]):[0-9]+"`
    );
  });

  it('writes fully qualified node names as a valid PromQL string', () => {
    expect(buildInstanceMatcher(['node-a001.cluster-a.example'], 'instance', 'hostname')).toBe(
      String.raw`instance=~"(node-a001\\.cluster-a\\.example)"`
    );
    expect(escapePromRegex('node"a\\001')).toBe(String.raw`node\"a\\\\001`);
  });

  it('builds a matcher that matches exactly the given node names', () => {
    const nodes = ['node-a001.cluster-a.example', 'node-a002', 'node"a\\003', 'node|a(004)+', 'node-a005\n'];
    const matcher = buildInstanceMatcher(nodes, 'instance', 'hostname');
    const quoted = matcher.slice('instance=~'.length);
    // The escapes that the matcher uses (\\, \" and \n) mean the same in a
    // PromQL string and in JSON. Prometheus anchors the regex at both ends.
    const regex = new RegExp(`^(?:${JSON.parse(quoted)})$`);

    for (const node of nodes) {
      expect(regex.test(node)).toBe(true);
    }
    for (const other of ['node-a001xcluster-a.example', 'node-a00', 'node-a0021', 'node"a\\0031', 'node|a(004)']) {
      expect(regex.test(other)).toBe(false);
    }
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

  it('uses submit time when start time is unset', () => {
    const pendingJob: JobRecord = { ...baseJob, state: 'PENDING', startTime: 0, endTime: 0 };

    expect(getJobTimeSettings(pendingJob)).toEqual({
      from: '2023-11-14T22:08:20.000Z',
      to: 'now',
      refreshIntervals: ['10s', '30s', '1m', '5m'],
    });
  });
});
