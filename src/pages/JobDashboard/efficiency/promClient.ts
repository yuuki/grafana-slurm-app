import { getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';

export type PromLabels = Record<string, string>;

export interface PromSample {
  metric: PromLabels;
  value: number;
}

export interface PromSeries {
  metric: PromLabels;
  /** [unix seconds, value] pairs; samples that are not finite numbers are left out. */
  values: Array<[number, number]>;
}

/** The two Prometheus HTTP API calls the scorecard needs. */
export interface MetricsClient {
  instant(expr: string, time: number): Promise<PromSample[]>;
  range(expr: string, start: number, end: number, step: number): Promise<PromSeries[]>;
}

interface PromVectorItem {
  metric?: PromLabels;
  value?: [number, string];
}

interface PromMatrixItem {
  metric?: PromLabels;
  values?: Array<[number, string]>;
}

interface PromResponse<T> {
  status?: string;
  error?: string;
  data?: { result?: T[] };
}

function toFinite(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Turns a failed proxy request into an Error that names the query's purpose. */
function describeQueryError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const { status, data, statusText, message } = error as {
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

async function post<T>(datasourceUid: string, path: string, params: Record<string, string>): Promise<T[]> {
  let response: PromResponse<T> | undefined;
  try {
    const result = await lastValueFrom(
      getBackendSrv().fetch<PromResponse<T>>({
        // The same route the Job Search utilization columns use: Grafana
        // checks the user's datasource permission and adds the credentials.
        url: `/api/datasources/proxy/uid/${encodeURIComponent(datasourceUid)}/api/v1/${path}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: new URLSearchParams(params).toString(),
        // The scorecard reports failures itself; no global error toast.
        showErrorAlert: false,
      })
    );
    response = result.data;
  } catch (error) {
    throw new Error(`Metrics query failed (${describeQueryError(error)})`);
  }
  if (response?.status === 'error') {
    throw new Error(`Metrics query failed (${response.error ?? 'unknown error'})`);
  }
  return Array.isArray(response?.data?.result) ? response.data.result : [];
}

/** A MetricsClient that queries a Grafana datasource through the datasource proxy. */
export function createDatasourceClient(datasourceUid: string): MetricsClient {
  return {
    async instant(expr, time) {
      const items = await post<PromVectorItem>(datasourceUid, 'query', { query: expr, time: String(time) });
      const samples: PromSample[] = [];
      for (const item of items) {
        const value = toFinite(item.value?.[1]);
        if (value !== undefined) {
          samples.push({ metric: item.metric ?? {}, value });
        }
      }
      return samples;
    },
    async range(expr, start, end, step) {
      const items = await post<PromMatrixItem>(datasourceUid, 'query_range', {
        query: expr,
        start: String(start),
        end: String(end),
        step: `${step}s`,
      });
      return items.map((item) => {
        const values: Array<[number, number]> = [];
        for (const [timestamp, raw] of item.values ?? []) {
          const value = toFinite(raw);
          if (value !== undefined) {
            values.push([Number(timestamp), value]);
          }
        }
        return { metric: item.metric ?? {}, values };
      });
    },
  };
}
