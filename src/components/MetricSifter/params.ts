import type { MetricSifterParams } from '../../api/types';

export const metricSifterSearchMethodOptions = ['pelt', 'binseg', 'bottomup'] as const;
export const metricSifterCostModelOptions = ['l1', 'l2', 'normal', 'rbf', 'linear', 'clinear', 'rank', 'mahalanobis', 'ar'] as const;
export const metricSifterSegmentSelectionOptions = ['weighted_max', 'max'] as const;

export const defaultMetricSifterParams: MetricSifterParams = {
  searchMethod: 'pelt',
  costModel: 'l2',
  penalty: 'bic',
  penaltyAdjust: 2,
  bandwidth: 2.5,
  segmentSelectionMethod: 'weighted_max',
  nJobs: 1,
  withoutSimpleFilter: false,
};

function includesOption<T extends string>(options: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && options.includes(value as T);
}

export type MetricSifterRuntimeOverrides = {
  enabled: boolean;
  params: MetricSifterParams;
};

export function cloneMetricSifterParams(
  params?: Partial<MetricSifterParams> | null,
  defaults: MetricSifterParams = defaultMetricSifterParams
): MetricSifterParams {
  return normalizeMetricSifterParams(params, defaults);
}

export function normalizeMetricSifterPenalty(
  value: unknown,
  fallback: MetricSifterParams['penalty'] = defaultMetricSifterParams.penalty
): MetricSifterParams['penalty'] {
  if (value === 'aic' || value === 'bic') {
    return value;
  }

  const numericValue = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(numericValue)) {
    return numericValue;
  }

  return fallback;
}

export function normalizeMetricSifterParams(
  value?: Partial<MetricSifterParams> | null,
  defaults: MetricSifterParams = defaultMetricSifterParams
): MetricSifterParams {
  const candidate = value ?? {};
  const searchMethod = includesOption(metricSifterSearchMethodOptions, candidate.searchMethod)
    ? candidate.searchMethod
    : defaults.searchMethod;
  const costModel = includesOption(metricSifterCostModelOptions, candidate.costModel)
    ? candidate.costModel
    : defaults.costModel;
  const segmentSelectionMethod = includesOption(metricSifterSegmentSelectionOptions, candidate.segmentSelectionMethod)
    ? candidate.segmentSelectionMethod
    : defaults.segmentSelectionMethod;
  const penaltyAdjust = Number(candidate.penaltyAdjust);
  const bandwidth = Number(candidate.bandwidth);
  const nJobs = Number(candidate.nJobs);

  return {
    searchMethod,
    costModel,
    penalty: normalizeMetricSifterPenalty(candidate.penalty, defaults.penalty),
    penaltyAdjust: Number.isFinite(penaltyAdjust) && penaltyAdjust > 0 ? penaltyAdjust : defaults.penaltyAdjust,
    bandwidth: Number.isFinite(bandwidth) && bandwidth > 0 ? bandwidth : defaults.bandwidth,
    segmentSelectionMethod,
    nJobs: Number.isInteger(nJobs) && nJobs !== 0 ? nJobs : defaults.nJobs,
    withoutSimpleFilter: candidate.withoutSimpleFilter ?? defaults.withoutSimpleFilter,
  };
}

export function normalizeMetricSifterRuntimeOverrides(
  value: unknown,
  defaults: MetricSifterParams = defaultMetricSifterParams
): MetricSifterRuntimeOverrides {
  if (!value || typeof value !== 'object') {
    return {
      enabled: false,
      params: cloneMetricSifterParams(undefined, defaults),
    };
  }

  const candidate = value as Partial<MetricSifterRuntimeOverrides>;
  return {
    enabled: Boolean(candidate.enabled),
    params: normalizeMetricSifterParams(candidate.params, defaults),
  };
}
