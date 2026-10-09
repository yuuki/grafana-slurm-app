import { act, renderHook, waitFor } from '@testing-library/react';
import { ClusterSummary, JobRecord } from '../../api/types';
import { fetchCompareSeries } from './metricQuery';
import { useCompareData } from './useCompareData';

jest.mock('./metricQuery', () => ({
  fetchCompareSeries: jest.fn(),
}));

const mockedFetch = fetchCompareSeries as jest.MockedFunction<typeof fetchCompareSeries>;

const cluster = { id: 'a100', metricsDatasourceUid: 'prom' } as ClusterSummary;
const job = { clusterId: 'a100', jobId: 1, nodes: ['n1'], startTime: 10, endTime: 20 } as JobRecord;
const series = { times: [10], mean: [1], min: [1], max: [1] };

describe('useCompareData', () => {
  beforeEach(() => mockedFetch.mockReset());

  it('does nothing without a metric', () => {
    const { result } = renderHook(() =>
      useCompareData({ jobs: [job], cluster, metric: '', metricType: 'gauge' })
    );
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });

  it('loads series and exposes them', async () => {
    mockedFetch.mockResolvedValue({ series: new Map([['a100-1', series]]), failedJobKeys: new Set() });
    const { result } = renderHook(() =>
      useCompareData({ jobs: [job], cluster, metric: 'up', metricType: 'gauge' })
    );
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.series.get('a100-1')).toEqual(series);
    expect(mockedFetch).toHaveBeenCalledWith(
      expect.objectContaining({ jobs: [job], cluster, metricName: 'up', metricType: 'gauge' })
    );
  });

  it('marks every job as failed when the fetch throws', async () => {
    mockedFetch.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() =>
      useCompareData({ jobs: [job], cluster, metric: 'up', metricType: 'gauge' })
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect([...result.current.failedJobKeys]).toEqual(['a100-1']);
  });

  it('refetches on retry and ignores stale responses', async () => {
    let resolveFirst: (value: Awaited<ReturnType<typeof fetchCompareSeries>>) => void = () => {};
    mockedFetch
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce({ series: new Map([['a100-1', series]]), failedJobKeys: new Set() });
    const { result } = renderHook(() =>
      useCompareData({ jobs: [job], cluster, metric: 'up', metricType: 'gauge' })
    );
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.series.size).toBe(1));
    act(() => resolveFirst({ series: new Map(), failedJobKeys: new Set(['a100-1']) }));
    await act(async () => {});
    expect(result.current.failedJobKeys.size).toBe(0);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });
});
