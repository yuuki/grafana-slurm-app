import { of, throwError } from 'rxjs';

const mockFetch = jest.fn();

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({ fetch: mockFetch }),
}));

import { createDatasourceClient } from './promClient';

function requestParams(callIndex = 0): URLSearchParams {
  return new URLSearchParams(mockFetch.mock.calls[callIndex][0].data);
}

describe('createDatasourceClient', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('sends instant queries through the datasource proxy as a POST form', async () => {
    mockFetch.mockReturnValue(
      of({ data: { status: 'success', data: { resultType: 'vector', result: [{ metric: { gpu: '0' }, value: [1700000000, '42.5'] }] } } })
    );

    const samples = await createDatasourceClient('prom/main').instant('up{instance=~"(a|b):[0-9]+"}', 1700000000);

    expect(samples).toEqual([{ metric: { gpu: '0' }, value: 42.5 }]);
    const request = mockFetch.mock.calls[0][0];
    expect(request.url).toBe('/api/datasources/proxy/uid/prom%2Fmain/api/v1/query');
    expect(request.method).toBe('POST');
    expect(request.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
    expect(request.showErrorAlert).toBe(false);
    expect(requestParams().get('query')).toBe('up{instance=~"(a|b):[0-9]+"}');
    expect(requestParams().get('time')).toBe('1700000000');
  });

  it('sends range queries with start, end and a step in seconds', async () => {
    mockFetch.mockReturnValue(
      of({
        data: {
          status: 'success',
          data: {
            resultType: 'matrix',
            result: [{ metric: { instance: 'gpu-node001:9400', gpu: '1' }, values: [[1700000060, '0'], [1700000120, '97.5']] }],
          },
        },
      })
    );

    const series = await createDatasourceClient('prom-main').range('max by (instance, gpu) (x)', 1700000060, 1700000120, 60);

    expect(series).toEqual([
      {
        metric: { instance: 'gpu-node001:9400', gpu: '1' },
        values: [
          [1700000060, 0],
          [1700000120, 97.5],
        ],
      },
    ]);
    expect(mockFetch.mock.calls[0][0].url).toBe('/api/datasources/proxy/uid/prom-main/api/v1/query_range');
    expect(Object.fromEntries(requestParams())).toEqual({
      query: 'max by (instance, gpu) (x)',
      start: '1700000060',
      end: '1700000120',
      step: '60s',
    });
  });

  it('drops samples that are not finite numbers instead of reading them as 0', async () => {
    mockFetch
      .mockReturnValueOnce(
        of({
          data: {
            status: 'success',
            data: {
              result: [
                { metric: { gpu: '0' }, value: [1, 'NaN'] },
                { metric: { gpu: '1' }, value: [1, '+Inf'] },
                { metric: { gpu: '2' }, value: [1, '3'] },
                { metric: { gpu: '3' } },
              ],
            },
          },
        })
      )
      .mockReturnValueOnce(of({ data: { status: 'success', data: { result: [{ metric: { gpu: '0' }, values: [[60, 'NaN'], [120, '7']] }] } } }));

    const client = createDatasourceClient('prom-main');
    expect(await client.instant('x', 1)).toEqual([{ metric: { gpu: '2' }, value: 3 }]);
    expect(await client.range('x', 60, 120, 60)).toEqual([{ metric: { gpu: '0' }, values: [[120, 7]] }]);
  });

  it('returns no samples for an empty result, also with an empty list of warnings', async () => {
    mockFetch
      .mockReturnValueOnce(of({ data: { status: 'success', data: { result: [] } } }))
      .mockReturnValueOnce(of({ data: { status: 'success', warnings: [], isPartial: false, data: { result: [] } } }));

    const client = createDatasourceClient('prom-main');
    expect(await client.instant('x', 1)).toEqual([]);
    expect(await client.range('x', 60, 120, 60)).toEqual([]);
  });

  it.each([
    ['an HTML page', '<html>login</html>'],
    ['an empty object', {}],
    ['nothing', undefined],
    ['a success without a result', { status: 'success', data: {} }],
    ['a result that is not a list', { status: 'success', data: { result: 'x' } }],
    ['a result without a status', { data: { result: [] } }],
  ])('treats a 200 response that is not a Prometheus API response as a failure, not as no data: %s', async (_name, body) => {
    mockFetch.mockReturnValue(of({ data: body }));

    const client = createDatasourceClient('prom-main');
    const message = 'Metrics query failed (the datasource did not return a Prometheus API response)';
    await expect(client.instant('x', 1)).rejects.toThrow(message);
    await expect(client.range('x', 60, 120, 60)).rejects.toThrow(message);
  });

  it('treats a partial result as a failure: the series that are missing are not known', async () => {
    const gpu = { metric: { gpu: '0' }, values: [[60, '0']] };
    mockFetch
      .mockReturnValueOnce(of({ data: { status: 'success', warnings: ['partial response: store x unavailable', 'timeout'], data: { result: [gpu] } } }))
      .mockReturnValueOnce(of({ data: { status: 'success', isPartial: true, data: { result: [gpu] } } }));

    const client = createDatasourceClient('prom-main');
    await expect(client.range('x', 60, 120, 60)).rejects.toThrow(
      'Metrics query failed (the result is partial: partial response: store x unavailable; timeout)'
    );
    await expect(client.range('x', 60, 120, 60)).rejects.toThrow('Metrics query failed (the result is partial)');
  });

  it('reports the HTTP status and the Prometheus error of a failed request', async () => {
    mockFetch.mockReturnValue(throwError(() => ({ status: 422, data: { error: 'parse error: unexpected character' } })));

    await expect(createDatasourceClient('prom-main').instant('x{', 1)).rejects.toThrow(
      'Metrics query failed (HTTP 422: parse error: unexpected character)'
    );
  });

  it('reports a failure without details', async () => {
    mockFetch.mockReturnValueOnce(throwError(() => ({ status: 502 }))).mockReturnValueOnce(throwError(() => 'boom'));

    const client = createDatasourceClient('prom-main');
    await expect(client.range('x', 60, 120, 60)).rejects.toThrow('Metrics query failed (HTTP 502)');
    await expect(client.range('x', 60, 120, 60)).rejects.toThrow('Metrics query failed (request failed)');
  });

  it('treats a 200 response with status "error" as a failure', async () => {
    mockFetch.mockReturnValue(of({ data: { status: 'error', error: 'query timed out' } }));

    await expect(createDatasourceClient('prom-main').instant('x', 1)).rejects.toThrow('Metrics query failed (query timed out)');
  });
});
