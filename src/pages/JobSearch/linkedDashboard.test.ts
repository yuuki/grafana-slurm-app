import { JobRecord, LinkedDashboardSummary } from '../../api/types';
import { buildLinkedDashboardUrl, sortLinkedDashboards } from './linkedDashboard';

describe('linked dashboard URL builder', () => {
  const job: JobRecord = {
    clusterId: 'a100',
    jobId: 10001,
    name: 'train-llm',
    user: 'researcher1',
    account: 'ml-team',
    partition: 'gpu-a100',
    state: 'RUNNING',
    nodes: ['gpu-node001', 'gpu-node002'],
    nodeCount: 2,
    gpusTotal: 8,
    submitTime: 1699999700,
    startTime: 1700000000,
    endTime: 1700003600,
    exitCode: 0,
    workDir: '/tmp',
    tres: 'gres/gpu=8',
    templateId: 'overview',
  };

  it('builds a linked dashboard URL with job metadata variables and absolute time range', () => {
    const url = buildLinkedDashboardUrl('/d/linked-job-dashboard/job-detail', job, 1700007200000);

    expect(url).toContain('/d/linked-job-dashboard/job-detail?');
    expect(url).toContain('from=1700000000000');
    expect(url).toContain('to=1700003600000');
    expect(url).toContain('var-slurm_cluster_id=a100');
    expect(url).toContain('var-slurm_job_id=10001');
    expect(url).toContain('var-slurm_job_name=train-llm');
    expect(url).toContain('var-slurm_nodes_csv=gpu-node001%2Cgpu-node002');
    expect(url).toContain('var-slurm_node=gpu-node001');
    expect(url).toContain('var-slurm_node=gpu-node002');
  });

  it('uses now for the end of the time range when the job is still running', () => {
    const url = buildLinkedDashboardUrl('/d/linked-job-dashboard/job-detail', { ...job, endTime: 0 }, 1700007200000);

    expect(url).toContain('to=1700007200000');
  });

  it('does not append repeated node variables when the job has no nodes', () => {
    const url = buildLinkedDashboardUrl('/d/linked-job-dashboard/job-detail', { ...job, nodes: [], nodeCount: 0 }, 1700007200000);

    expect(url).toContain('var-slurm_nodes_csv=');
    expect(url).not.toContain('var-slurm_node=');
  });

  it('sorts linked dashboards with the preferred dashboard first, then by title', () => {
    const dashboards: LinkedDashboardSummary[] = [
      { uid: 'b', title: 'Beta Dashboard', url: '/d/beta', tags: [] },
      { uid: 'a', title: 'Alpha Dashboard', url: '/d/alpha', tags: [] },
      { uid: 'c', title: 'Gamma Dashboard', url: '/d/gamma', tags: [] },
    ];

    expect(sortLinkedDashboards(dashboards, 'c').map((dashboard) => dashboard.uid)).toEqual(['c', 'a', 'b']);
    expect(sortLinkedDashboards(dashboards, null).map((dashboard) => dashboard.uid)).toEqual(['a', 'b', 'c']);
  });
});
