import { of, throwError } from 'rxjs';
import { createDatasourceClient, MetricsQueryError, parseMatrix, parseVector, readResult } from './promClient';

const mockFetch = jest.fn();

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({ fetch: mockFetch }),
}));

function respondWith(data: unknown): void {
  mockFetch.mockReturnValue(of({ data }));
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('readResult', () => {
  it('returns the result of a complete success response', () => {
    expect(readResult({ status: 'success', data: { resultType: 'matrix', result: [1, 2] } }, 'matrix')).toEqual([1, 2]);
    expect(readResult({ status: 'success', data: { resultType: 'vector', result: [] } }, 'vector')).toEqual([]);
  });

  it.each([
    ['an error response', { status: 'error', error: 'bad_data: parse error' }, 'Metrics query failed (bad_data: parse error)'],
    ['an error response without text', { status: 'error' }, 'Metrics query failed (unknown error)'],
    ['an HTML page', '<html>login</html>', 'Metrics query failed (the datasource did not return a Prometheus API response)'],
    ['nothing', undefined, 'Metrics query failed (the datasource did not return a Prometheus API response)'],
    ['a response without a result', { status: 'success', data: { resultType: 'matrix' } }, 'did not return a Prometheus API response'],
    ['a result of another type', { status: 'success', data: { resultType: 'vector', result: [] } }, 'did not return a Prometheus API response'],
    [
      'a result with warnings',
      { status: 'success', warnings: ['store did not answer'], data: { resultType: 'matrix', result: [] } },
      'Metrics query failed (the result is partial: store did not answer)',
    ],
    ['a partial result', { status: 'success', isPartial: true, data: { resultType: 'matrix', result: [] } }, 'Metrics query failed (the result is partial)'],
  ])('rejects %s instead of reading it as an empty result', (_name, response, message) => {
    expect(() => readResult(response, 'matrix')).toThrow(MetricsQueryError);
    expect(() => readResult(response, 'matrix')).toThrow(message);
  });

  it('accepts info annotations, which do not make a result partial', () => {
    const response = { status: 'success', infos: ['metric might not be a counter'], data: { resultType: 'matrix', result: [] } };
    expect(readResult(response, 'matrix')).toEqual([]);
  });
});

describe('parseMatrix and parseVector', () => {
  it('keeps finite values and drops the others', () => {
    expect(
      parseMatrix([
        { metric: { instance: 'node-a001:9400', bad: 5 }, values: [[60, '1.5'], [120, 'NaN'], [180, '+Inf'], ['x', '2'], [240, '3']] },
        { metric: null, values: 'broken' },
        null,
      ])
    ).toEqual([
      { metric: { instance: 'node-a001:9400' }, values: [[60, 1.5], [240, 3]] },
      { metric: {}, values: [] },
      { metric: {}, values: [] },
    ]);
  });

  it('reads instant samples and marks unreadable values as NaN', () => {
    const samples = parseVector([{ metric: { samples: '240' }, value: [100, '8'] }, { metric: {}, value: 'broken' }, { metric: {}, value: [100, 'NaN'] }]);
    expect(samples[0]).toEqual({ metric: { samples: '240' }, value: 8 });
    expect(Number.isNaN(samples[1].value)).toBe(true);
    expect(Number.isNaN(samples[2].value)).toBe(true);
  });
});

describe('createDatasourceClient', () => {
  it('posts a range query through the datasource proxy without an error toast', async () => {
    respondWith({ status: 'success', data: { resultType: 'matrix', result: [{ metric: { instance: 'node-a001:9400' }, values: [[120, '42']] }] } });
    const controller = new AbortController();
    const client = createDatasourceClient('prom a/1', controller.signal);

    await expect(client.range('avg(up)', 120, 600, 60)).resolves.toEqual([{ metric: { instance: 'node-a001:9400' }, values: [[120, 42]] }]);
    expect(mockFetch).toHaveBeenCalledWith({
      url: '/api/datasources/proxy/uid/prom%20a%2F1/api/v1/query_range',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: 'query=avg%28up%29&start=120&end=600&step=60s',
      showErrorAlert: false,
      abortSignal: controller.signal,
    });
  });

  it('posts an instant query', async () => {
    respondWith({ status: 'success', data: { resultType: 'vector', result: [{ metric: { samples: '240' }, value: [600, '8'] }] } });
    await expect(createDatasourceClient('prom-a').instant('count(up)', 600)).resolves.toEqual([{ metric: { samples: '240' }, value: 8 }]);
    expect(mockFetch.mock.calls[0][0]).toMatchObject({ url: '/api/datasources/proxy/uid/prom-a/api/v1/query', data: 'query=count%28up%29&time=600' });
  });

  it.each([
    [{ status: 403, data: { message: 'Access denied to this datasource' } }, 'Metrics query failed (HTTP 403: Access denied to this datasource)'],
    [{ status: 422, data: { error: 'query timed out' } }, 'Metrics query failed (HTTP 422: query timed out)'],
    [{ status: 502 }, 'Metrics query failed (HTTP 502)'],
    [new Error('network down'), 'Metrics query failed (network down)'],
    ['boom', 'Metrics query failed (request failed)'],
  ])('turns a failed request into a metrics query error', async (error, message) => {
    mockFetch.mockReturnValue(throwError(() => error));
    await expect(createDatasourceClient('prom-a').range('up', 1, 2, 1)).rejects.toThrow(message);
    await expect(createDatasourceClient('prom-a').range('up', 1, 2, 1)).rejects.toBeInstanceOf(MetricsQueryError);
  });

  it('rejects a response that is not a Prometheus API result', async () => {
    respondWith('<html>login</html>');
    await expect(createDatasourceClient('prom-a').range('up', 1, 2, 1)).rejects.toThrow('did not return a Prometheus API response');
  });
});
