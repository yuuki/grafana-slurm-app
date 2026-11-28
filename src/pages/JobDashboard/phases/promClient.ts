/**
 * The two Prometheus HTTP API calls of the phase segmentation, sent through
 * Grafana's datasource proxy like every other metrics query of the plugin:
 * Grafana checks the user's datasource permission and adds the credentials.
 */
import { getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';

export type PromLabels = Record<string, string>;

export interface PromInstantSample {
  metric: PromLabels;
  /** NaN when the backend returned a value that is not a finite number. */
  value: number;
}

export interface PromRangeSeries {
  metric: PromLabels;
  /** [unix seconds, value] pairs; values that are not finite numbers are left out. */
  values: Array<[number, number]>;
}

export interface MetricsClient {
  instant(expr: string, time: number): Promise<PromInstantSample[]>;
  range(expr: string, start: number, end: number, step: number): Promise<PromRangeSeries[]>;
}

/** A metrics query that did not return a complete result. */
export class MetricsQueryError extends Error {
  constructor(detail: string) {
    super(`Metrics query failed (${detail})`);
    this.name = 'MetricsQueryError';
  }
}

interface PromResponse {
  status?: unknown;
  error?: unknown;
  /** Prometheus and Thanos: the result may be incomplete. */
  warnings?: unknown;
  /** VictoriaMetrics cluster: a storage node did not answer. */
  isPartial?: unknown;
  data?: { resultType?: unknown; result?: unknown };
}

type ResultType = 'vector' | 'matrix';

/**
 * The result list of a response, or an error. Only a complete Prometheus API
 * success response of the expected type is data. Anything else (an HTML
 * login page behind the proxy, a partial result) must not read as "the
 * query matched nothing": the segmentation would report missing telemetry.
 */
export function readResult(response: unknown, resultType: ResultType): unknown[] {
  const body: PromResponse = typeof response === 'object' && response !== null ? response : {};
  if (body.status === 'error') {
    throw new MetricsQueryError(typeof body.error === 'string' ? body.error : 'unknown error');
  }
  const result = body.data?.result;
  if (body.status !== 'success' || body.data?.resultType !== resultType || !Array.isArray(result)) {
    throw new MetricsQueryError('the datasource did not return a Prometheus API response');
  }
  const warnings = Array.isArray(body.warnings) ? body.warnings.filter((warning) => typeof warning === 'string') : [];
  if (body.isPartial === true || warnings.length > 0) {
    throw new MetricsQueryError(`the result is partial${warnings.length > 0 ? `: ${warnings.join('; ')}` : ''}`);
  }
  return result;
}

function labelsOf(item: unknown): PromLabels {
  const metric = (item as { metric?: unknown } | null)?.metric;
  const labels: PromLabels = {};
  if (typeof metric === 'object' && metric !== null) {
    for (const [name, value] of Object.entries(metric)) {
      if (typeof value === 'string') {
        labels[name] = value;
      }
    }
  }
  return labels;
}

function toNumber(raw: unknown): number {
  const value = typeof raw === 'string' ? parseFloat(raw) : NaN;
  return Number.isFinite(value) ? value : NaN;
}

export function parseVector(result: unknown[]): PromInstantSample[] {
  return result.map((item) => {
    const value = (item as { value?: unknown } | null)?.value;
    return { metric: labelsOf(item), value: Array.isArray(value) ? toNumber(value[1]) : NaN };
  });
}

export function parseMatrix(result: unknown[]): PromRangeSeries[] {
  return result.map((item) => {
    const raw = (item as { values?: unknown } | null)?.values;
    const values: Array<[number, number]> = [];
    for (const pair of Array.isArray(raw) ? raw : []) {
      const timestamp = Array.isArray(pair) ? Number(pair[0]) : NaN;
      const value = Array.isArray(pair) ? toNumber(pair[1]) : NaN;
      if (Number.isFinite(timestamp) && Number.isFinite(value)) {
        values.push([timestamp, value]);
      }
    }
    return { metric: labelsOf(item), values };
  });
}

function describeRequestError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const { status, statusText, message, data } = error as {
      status?: number;
      statusText?: string;
      message?: string;
      data?: { error?: string; message?: string };
    };
    const detail = data?.error ?? data?.message ?? message ?? statusText;
    if (status && detail) {
      return `HTTP ${status}: ${detail}`;
    }
    if (status) {
      return `HTTP ${status}`;
    }
    if (detail) {
      return detail;
    }
  }
  return 'request failed';
}

async function post(datasourceUid: string, path: string, params: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  try {
    const response = await lastValueFrom(
      getBackendSrv().fetch<unknown>({
        url: `/api/datasources/proxy/uid/${encodeURIComponent(datasourceUid)}/api/v1/${path}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: new URLSearchParams(params).toString(),
        // The section reports failures itself; no global error toast.
        showErrorAlert: false,
        abortSignal: signal,
      })
    );
    return response.data;
  } catch (error) {
    throw new MetricsQueryError(describeRequestError(error));
  }
}

/** A MetricsClient for a Grafana datasource. The signal cancels requests that are under way. */
export function createDatasourceClient(datasourceUid: string, signal?: AbortSignal): MetricsClient {
  return {
    async instant(expr, time) {
      const response = await post(datasourceUid, 'query', { query: expr, time: String(time) }, signal);
      return parseVector(readResult(response, 'vector'));
    },
    async range(expr, start, end, step) {
      const response = await post(
        datasourceUid,
        'query_range',
        { query: expr, start: String(start), end: String(end), step: `${step}s` },
        signal
      );
      return parseMatrix(readResult(response, 'matrix'));
    },
  };
}
