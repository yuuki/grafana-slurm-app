import {
  loadJobDashboardPanelSelection,
  loadLinkedDashboardSelection,
  loadSearchPreferences,
  normalizeJobDashboardPanelSelection,
  saveJobDashboardPanelSelection,
  saveLinkedDashboardSelection,
  saveSearchPreferences,
} from './userPreferences';

describe('user preferences storage', () => {
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

  it('persists selected dashboard panels per job', () => {
    saveJobDashboardPanelSelection('a100', 10001, ['gpu-utilization', 'disk-read']);

    expect(loadJobDashboardPanelSelection('a100', 10001)).toEqual(['raw:gpu:DCGM_FI_DEV_GPU_UTIL']);
    expect(loadJobDashboardPanelSelection('a100', 20002)).toEqual([]);
  });

  it('drops invalid dashboard panel selections from storage', () => {
    window.localStorage.setItem(
      'yuuki-slurm-app.job-dashboard-panels:a100:10001',
      JSON.stringify(['gpu-utilization', 123, null])
    );

    expect(loadJobDashboardPanelSelection('a100', 10001)).toEqual(['raw:gpu:DCGM_FI_DEV_GPU_UTIL']);
  });

  it('migrates legacy dashboard panel selections to canonical keys', () => {
    window.localStorage.setItem(
      'yuuki-slurm-app.job-dashboard-panels:a100:10001',
      JSON.stringify(['gpu-utilization', 'disk-read', 'load-average-15m'])
    );

    expect(loadJobDashboardPanelSelection('a100', 10001)).toEqual([
      'raw:gpu:DCGM_FI_DEV_GPU_UTIL',
      'raw:node:node_load15',
    ]);
  });

  it('drops stored view keys because recommended views are no longer supported', () => {
    window.localStorage.setItem(
      'yuuki-slurm-app.job-dashboard-panels:a100:10001',
      JSON.stringify(['view:disk-read', 'raw:node:node_load15'])
    );

    expect(loadJobDashboardPanelSelection('a100', 10001)).toEqual(['raw:node:node_load15']);
  });

  it('normalizes dashboard panel selections consistently', () => {
    expect(
      normalizeJobDashboardPanelSelection([
        'gpu-utilization',
        'raw:gpu:DCGM_FI_DEV_GPU_UTIL',
        'view:disk-read',
        'raw:node:node_load15',
        null,
      ])
    ).toEqual(['raw:gpu:DCGM_FI_DEV_GPU_UTIL', 'raw:node:node_load15']);
  });

  it('persists the last linked dashboard selection per cluster', () => {
    saveLinkedDashboardSelection('a100', 'linked-job-dashboard');

    expect(loadLinkedDashboardSelection('a100')).toBe('linked-job-dashboard');
    expect(loadLinkedDashboardSelection('h100')).toBeNull();
  });
});
