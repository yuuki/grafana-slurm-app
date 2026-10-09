import { buildCompareRoute } from '../../constants';
import {
  buildCompareFromJobParams,
  buildCompareFromSearchParams,
  buildCompareURLParams,
  DEFAULT_VIEW_STATE,
  isValidMetricName,
  toggleJobSelection,
  viewStateFromURLParams,
  viewStateToURLParams,
} from './model';

describe('compare model', () => {
  it('builds the compare route with and without a query', () => {
    expect(buildCompareRoute()).toBe('/a/yuuki-slurm-app/compare');
    expect(buildCompareRoute(new URLSearchParams({ metric: 'up' }))).toBe('/a/yuuki-slurm-app/compare?metric=up');
  });

  it('omits default values from the URL', () => {
    expect(viewStateToURLParams(DEFAULT_VIEW_STATE).toString()).toBe('');
  });

  it('round-trips non-default view state', () => {
    const state = {
      ...DEFAULT_VIEW_STATE,
      metric: 'DCGM_FI_PROF_PIPE_TENSOR_ACTIVE',
      layout: 'overlay' as const,
      xAxis: 'progress' as const,
      reduce: 'max' as const,
      yScale: 'independent' as const,
      sort: 'mean-desc' as const,
      columns: '6' as const,
      elapsedLimitHours: 6,
      baselineJobId: '10231',
      jobSetMode: 'pick' as const,
      pickedJobIds: ['10231', '10388'],
      selectedJobIds: ['10388'],
    };
    expect({ ...DEFAULT_VIEW_STATE, ...viewStateFromURLParams(viewStateToURLParams(state)) }).toEqual(state);
  });

  it('ignores invalid enum values, metric names, and job ids', () => {
    const parsed = viewStateFromURLParams(
      new URLSearchParams('layout=table&x=bogus&metric=up%7Bjob%3D%22x%22%7D&jobs=1,abc,2&baseline=x1&xlimit=-3')
    );
    expect(parsed).toEqual({ pickedJobIds: ['1', '2'] });
  });

  it('validates metric names', () => {
    expect(isValidMetricName('DCGM_FI_DEV_GPU_UTIL')).toBe(true);
    expect(isValidMetricName('node:cpu:rate5m')).toBe(true);
    expect(isValidMetricName('up{job="x"}')).toBe(false);
    expect(isValidMetricName('')).toBe(false);
  });

  it('combines search filters, time range, and view state', () => {
    const params = buildCompareURLParams(
      { ...DEFAULT_VIEW_STATE, metric: 'up' },
      { clusterId: 'a100', jobId: '123', user: 'alice' },
      { from: 'now-7d', to: 'now' }
    );
    expect(params.get('cluster')).toBe('a100');
    expect(params.get('user')).toBe('alice');
    expect(params.get('job')).toBeNull();
    expect(params.get('from')).toBe('now-7d');
    expect(params.get('to')).toBe('now');
    expect(params.get('metric')).toBe('up');
  });

  it('opens pick mode when jobs are selected in Job Search', () => {
    const picked = buildCompareFromSearchParams({ clusterId: 'a100' }, { from: 'now-1d', to: 'now' }, ['1', '2']);
    expect(picked.get('mode')).toBe('pick');
    expect(picked.get('jobs')).toBe('1,2');
    const filtered = buildCompareFromSearchParams({ clusterId: 'a100', user: 'bob' }, { from: 'now-1d', to: 'now' }, []);
    expect(filtered.get('mode')).toBeNull();
    expect(filtered.get('user')).toBe('bob');
  });

  it('opens filter mode around a job with the job as baseline', () => {
    const params = buildCompareFromJobParams(
      { clusterId: 'a100', jobId: 10388, user: 'alice', name: 'llm-pretrain' },
      'DCGM_FI_PROF_PIPE_TENSOR_ACTIVE'
    );
    expect(params.get('cluster')).toBe('a100');
    expect(params.get('user')).toBe('alice');
    expect(params.get('name')).toBe('llm-pretrain');
    expect(params.get('from')).toBe('now-30d');
    expect(params.get('baseline')).toBe('10388');
    expect(params.get('metric')).toBe('DCGM_FI_PROF_PIPE_TENSOR_ACTIVE');
  });

  it('toggles job selection', () => {
    expect(toggleJobSelection([], '1')).toEqual(['1']);
    expect(toggleJobSelection(['1', '2'], '1')).toEqual(['2']);
  });
});
