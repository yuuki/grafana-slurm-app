import {
  loadJobDashboardPanelSelection,
  loadMetricSifterRuntimeOverrides,
  loadMetricExplorerSortBy,
  loadLinkedDashboardSelection,
  loadSearchPreferences,
  normalizeJobDashboardPanelSelection,
  saveJobDashboardPanelSelection,
  saveMetricExplorerSortBy,
  saveLinkedDashboardSelection,
  saveSearchPreferences,
} from './userPreferences';
import { defaultMetricSifterParams } from '../components/MetricSifter/params';

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

    expect(loadJobDashboardPanelSelection('a100', 10001)).toEqual([]);
    expect(loadJobDashboardPanelSelection('a100', 20002)).toEqual([]);
  });

  it('drops invalid dashboard panel selections from storage', () => {
    window.localStorage.setItem(
      'yuuki-slurm-app.job-dashboard-panels:a100:10001',
      JSON.stringify(['gpu-utilization', 123, null])
    );

    expect(loadJobDashboardPanelSelection('a100', 10001)).toEqual([]);
  });

  it('drops legacy named dashboard panel selections because only raw metric keys are supported', () => {
    window.localStorage.setItem(
      'yuuki-slurm-app.job-dashboard-panels:a100:10001',
      JSON.stringify(['gpu-utilization', 'disk-read', 'load-average-15m'])
    );

    expect(loadJobDashboardPanelSelection('a100', 10001)).toEqual([]);
  });

  it('drops stored view keys because recommended views are no longer supported', () => {
    window.localStorage.setItem(
      'yuuki-slurm-app.job-dashboard-panels:a100:10001',
      JSON.stringify(['view:disk-read', 'raw:node_load15'])
    );

    expect(loadJobDashboardPanelSelection('a100', 10001)).toEqual(['raw:node_load15']);
  });

  it('normalizes dashboard panel selections consistently', () => {
    expect(
      normalizeJobDashboardPanelSelection([
        'gpu-utilization',
        'raw:DCGM_FI_DEV_GPU_UTIL',
        'view:disk-read',
        'raw:node_load15',
        null,
      ])
    ).toEqual(['raw:DCGM_FI_DEV_GPU_UTIL', 'raw:node_load15']);
  });

  it('merges stored runtime overrides with admin defaults', () => {
    window.localStorage.setItem(
      'yuuki-slurm-app.metricsifter-runtime-overrides',
      JSON.stringify({
        enabled: true,
        params: {
          bandwidth: 4.5,
        },
      })
    );

    const restored = loadMetricSifterRuntimeOverrides({
      ...defaultMetricSifterParams,
      penaltyAdjust: 7,
    });

    expect(restored).toEqual({
      enabled: true,
      params: {
        ...defaultMetricSifterParams,
        bandwidth: 4.5,
        penaltyAdjust: 7,
      },
    });
  });

  it('persists the Metric Explorer sort preference and defaults to outliers', () => {
    expect(loadMetricExplorerSortBy()).toBe('outliers');

    saveMetricExplorerSortBy('name');
    expect(loadMetricExplorerSortBy()).toBe('name');

    window.localStorage.setItem('yuuki-slurm-app.metric-explorer-sort-by', JSON.stringify('invalid'));
    expect(loadMetricExplorerSortBy()).toBe('outliers');
  });

  it('persists the last linked dashboard selection per cluster', () => {
    saveLinkedDashboardSelection('a100', 'dashboard:linked-job-dashboard');

    expect(loadLinkedDashboardSelection('a100')).toBe('dashboard:linked-job-dashboard');
    expect(loadLinkedDashboardSelection('h100')).toBeNull();
  });

  it('persists a job view selection per cluster', () => {
    saveLinkedDashboardSelection('a100', 'job-view');

    expect(loadLinkedDashboardSelection('a100')).toBe('job-view');
    expect(loadLinkedDashboardSelection('h100')).toBeNull();
  });

  it('normalizes legacy dashboard uid selections from storage', () => {
    window.localStorage.setItem(
      'yuuki-slurm-app.linked-dashboard-selection',
      JSON.stringify({
        a100: 'linked-job-dashboard',
      })
    );

    expect(loadLinkedDashboardSelection('a100')).toBe('dashboard:linked-job-dashboard');
  });
});
