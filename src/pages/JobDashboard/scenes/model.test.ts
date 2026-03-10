import { buildInstanceMatcher, getJobTimeSettings, buildInstanceValues, buildExternalDashboardUrl } from './model';
import { ClusterSummary, JobRecord } from '../../../api/types';

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
    nodeCount: 2,
    gpusTotal: 16,
    startTime: 1700000000,
    endTime: 0,
    exitCode: 0,
    workDir: '/tmp',
    tres: '1001=gres/gpu:16',
    templateId: 'distributed-training',
  };

  it('builds host:port matcher by default', () => {
    expect(buildInstanceMatcher(baseJob.nodes, 'instance', '9100', 'host:port')).toBe('instance=~"(gpu-node001|gpu-node002):9100"');
  });

  it('builds hostname matcher without exporter port suffix', () => {
    expect(buildInstanceMatcher(baseJob.nodes, 'instance', '9100', 'hostname')).toBe('instance=~"(gpu-node001|gpu-node002)"');
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

describe('buildInstanceValues', () => {
  it('returns host:port values by default', () => {
    expect(buildInstanceValues(['node001', 'node002'], '9100', 'host:port')).toEqual([
      'node001:9100',
      'node002:9100',
    ]);
  });

  it('returns hostname-only values in hostname mode', () => {
    expect(buildInstanceValues(['node001', 'node002'], '9100', 'hostname')).toEqual([
      'node001',
      'node002',
    ]);
  });

  it('returns empty array for empty nodes', () => {
    expect(buildInstanceValues([], '9100', 'host:port')).toEqual([]);
  });
});

describe('buildExternalDashboardUrl', () => {
  const cluster: ClusterSummary = {
    id: 'a100',
    displayName: 'A100 Cluster',
    slurmClusterName: 'a100',
    metricsDatasourceUid: 'prom-uid',
    metricsType: 'prometheus',
    instanceLabel: 'instance',
    nodeExporterPort: '9100',
    dcgmExporterPort: '9400',
    nodeMatcherMode: 'host:port',
    defaultTemplateId: 'overview',
    metricsFilterLabel: '',
    metricsFilterValue: '',
  };

  const completedJob: JobRecord = {
    clusterId: 'a100',
    jobId: 10001,
    name: 'train_llm',
    user: 'researcher1',
    account: 'ml-team',
    partition: 'gpu-a100',
    state: 'COMPLETED',
    nodes: ['gpu-node001', 'gpu-node002'],
    nodeCount: 2,
    gpusTotal: 16,
    startTime: 1700000000,
    endTime: 1700003600,
    exitCode: 0,
    workDir: '/tmp',
    tres: '1001=gres/gpu:16',
    templateId: 'distributed-training',
  };

  it('builds URL with time range and instance vars for completed job', () => {
    const url = buildExternalDashboardUrl('/d/abc123/my-dashboard', completedJob, cluster);
    const parsed = new URL(url, 'http://localhost');
    expect(parsed.pathname).toBe('/d/abc123/my-dashboard');
    expect(parsed.searchParams.get('from')).toBe('1700000000000');
    expect(parsed.searchParams.get('to')).toBe('1700003600000');
    expect(parsed.searchParams.getAll('var-instance')).toEqual([
      'gpu-node001:9100',
      'gpu-node002:9100',
    ]);
  });

  it('uses "now" for running job end time', () => {
    const runningJob: JobRecord = { ...completedJob, state: 'RUNNING', endTime: 0 };
    const url = buildExternalDashboardUrl('/d/abc123/my-dashboard', runningJob, cluster);
    const parsed = new URL(url, 'http://localhost');
    expect(parsed.searchParams.get('to')).toBe('now');
  });

  it('uses hostname mode when configured', () => {
    const hostnameCluster = { ...cluster, nodeMatcherMode: 'hostname' as const };
    const url = buildExternalDashboardUrl('/d/abc123/my-dashboard', completedJob, hostnameCluster);
    const parsed = new URL(url, 'http://localhost');
    expect(parsed.searchParams.getAll('var-instance')).toEqual([
      'gpu-node001',
      'gpu-node002',
    ]);
  });

  it('omits var-instance when nodes are empty', () => {
    const noNodesJob: JobRecord = { ...completedJob, nodes: [], nodeCount: 0 };
    const url = buildExternalDashboardUrl('/d/abc123/my-dashboard', noNodesJob, cluster);
    const parsed = new URL(url, 'http://localhost');
    expect(parsed.searchParams.getAll('var-instance')).toEqual([]);
  });
});
