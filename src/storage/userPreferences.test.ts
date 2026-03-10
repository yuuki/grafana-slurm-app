import {
  loadJobDashboardPanelSelection,
  loadRecentJobs,
  loadSearchPreferences,
  pushRecentJob,
  saveJobDashboardPanelSelection,
  saveSearchPreferences,
} from './userPreferences';
import { JobRecord } from '../api/types';

describe('user preferences storage', () => {
  const sampleJob: JobRecord = {
    clusterId: 'a100',
    jobId: 10001,
    name: 'train_llm',
    user: 'researcher1',
    account: 'ml-team',
    partition: 'gpu-a100',
    state: 'RUNNING',
    nodes: ['gpu-node001'],
    nodeCount: 1,
    gpusTotal: 8,
    startTime: 1700000000,
    endTime: 0,
    exitCode: 0,
    workDir: '/tmp',
    tres: '1001=gres/gpu:8',
    templateId: 'distributed-training',
  };

  beforeEach(() => {
    window.localStorage.clear();
  });

  it('persists and restores search preferences', () => {
    saveSearchPreferences({
      clusterId: 'a100',
      user: 'researcher1',
      account: 'ml-team',
      state: 'RUNNING',
    });

    expect(loadSearchPreferences()).toMatchObject({
      clusterId: 'a100',
      user: 'researcher1',
      account: 'ml-team',
      state: 'RUNNING',
    });
  });

  it('stores recent jobs with de-duplication', () => {
    pushRecentJob(sampleJob);
    pushRecentJob({ ...sampleJob, name: 'train_llm_updated' });

    expect(loadRecentJobs()).toEqual([
      expect.objectContaining({
        clusterId: 'a100',
        jobId: 10001,
        name: 'train_llm_updated',
      }),
    ]);
  });

  it('persists selected dashboard panels per job', () => {
    saveJobDashboardPanelSelection('a100', 10001, ['gpu-utilization', 'disk-read']);

    expect(loadJobDashboardPanelSelection('a100', 10001)).toEqual(['gpu-utilization', 'disk-read']);
    expect(loadJobDashboardPanelSelection('a100', 20002)).toEqual([]);
  });

  it('drops invalid dashboard panel selections from storage', () => {
    window.localStorage.setItem(
      'yuuki-slurm-app.job-dashboard-panels:a100:10001',
      JSON.stringify(['gpu-utilization', 123, null])
    );

    expect(loadJobDashboardPanelSelection('a100', 10001)).toEqual(['gpu-utilization']);
  });
});
