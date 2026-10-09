import { JobRecord } from '../../api/types';
import { filtersFromURLParams, filtersToURLParams, SearchFilters } from '../JobSearch/model';

export const COMPARE_JOB_LIMIT = 48;
export const OVERLAY_LINE_LIMIT = 10;
export const PROFILE_BINS = 200;
export const DEFAULT_COMPARE_RAW_FROM = 'now-7d';
export const DEFAULT_COMPARE_RAW_TO = 'now';
export const COMPARE_FROM_JOB_RAW_FROM = 'now-30d';

export type CompareLayout = 'grid' | 'overlay';
export type CompareXAxis = 'elapsed' | 'progress' | 'absolute';
export type CompareReduce = 'mean' | 'band' | 'max' | 'min';
export type CompareYScale = 'shared' | 'independent';
export type CompareSort = 'deviation' | 'mean-desc' | 'mean-asc' | 'start' | 'duration' | 'job-id';
export type CompareColumns = 'auto' | '2' | '3' | '4' | '6';
export type JobSetMode = 'filter' | 'pick';

export interface CompareViewState {
  metric: string;
  layout: CompareLayout;
  xAxis: CompareXAxis;
  reduce: CompareReduce;
  yScale: CompareYScale;
  sort: CompareSort;
  columns: CompareColumns;
  // 0 means the whole job. Only applies to the elapsed axis.
  elapsedLimitHours: number;
  baselineJobId: string;
  jobSetMode: JobSetMode;
  pickedJobIds: string[];
  selectedJobIds: string[];
}

export const DEFAULT_VIEW_STATE: CompareViewState = {
  metric: '',
  layout: 'grid',
  xAxis: 'elapsed',
  reduce: 'band',
  yScale: 'shared',
  sort: 'deviation',
  columns: 'auto',
  elapsedLimitHours: 0,
  baselineJobId: '',
  jobSetMode: 'filter',
  pickedJobIds: [],
  selectedJobIds: [],
};

const LAYOUTS: readonly CompareLayout[] = ['grid', 'overlay'];
const X_AXES: readonly CompareXAxis[] = ['elapsed', 'progress', 'absolute'];
const REDUCES: readonly CompareReduce[] = ['mean', 'band', 'max', 'min'];
const Y_SCALES: readonly CompareYScale[] = ['shared', 'independent'];
const SORTS: readonly CompareSort[] = ['deviation', 'mean-desc', 'mean-asc', 'start', 'duration', 'job-id'];
const COLUMNS: readonly CompareColumns[] = ['auto', '2', '3', '4', '6'];
const JOB_SET_MODES: readonly JobSetMode[] = ['filter', 'pick'];

const METRIC_NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const JOB_ID_PATTERN = /^[0-9]+$/;

export function isValidMetricName(name: string): boolean {
  return METRIC_NAME_PATTERN.test(name);
}

function pickEnum<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function parseIdList(value: string | null): string[] | undefined {
  if (!value) {
    return undefined;
  }
  return value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => JOB_ID_PATTERN.test(id));
}

export function viewStateToURLParams(state: CompareViewState): URLSearchParams {
  const params = new URLSearchParams();
  const d = DEFAULT_VIEW_STATE;
  if (state.metric) {
    params.set('metric', state.metric);
  }
  if (state.layout !== d.layout) {
    params.set('layout', state.layout);
  }
  if (state.xAxis !== d.xAxis) {
    params.set('x', state.xAxis);
  }
  if (state.reduce !== d.reduce) {
    params.set('reduce', state.reduce);
  }
  if (state.yScale !== d.yScale) {
    params.set('y', state.yScale);
  }
  if (state.sort !== d.sort) {
    params.set('sort', state.sort);
  }
  if (state.columns !== d.columns) {
    params.set('cols', state.columns);
  }
  if (state.elapsedLimitHours > 0) {
    params.set('xlimit', String(state.elapsedLimitHours));
  }
  if (state.baselineJobId) {
    params.set('baseline', state.baselineJobId);
  }
  if (state.jobSetMode !== d.jobSetMode) {
    params.set('mode', state.jobSetMode);
  }
  if (state.pickedJobIds.length > 0) {
    params.set('jobs', state.pickedJobIds.join(','));
  }
  if (state.selectedJobIds.length > 0) {
    params.set('sel', state.selectedJobIds.join(','));
  }
  return params;
}

export function viewStateFromURLParams(params: URLSearchParams): Partial<CompareViewState> {
  const state: Partial<CompareViewState> = {};
  const metric = params.get('metric');
  if (metric && isValidMetricName(metric)) {
    state.metric = metric;
  }
  const layout = pickEnum(params.get('layout'), LAYOUTS);
  if (layout) {
    state.layout = layout;
  }
  const xAxis = pickEnum(params.get('x'), X_AXES);
  if (xAxis) {
    state.xAxis = xAxis;
  }
  const reduce = pickEnum(params.get('reduce'), REDUCES);
  if (reduce) {
    state.reduce = reduce;
  }
  const yScale = pickEnum(params.get('y'), Y_SCALES);
  if (yScale) {
    state.yScale = yScale;
  }
  const sort = pickEnum(params.get('sort'), SORTS);
  if (sort) {
    state.sort = sort;
  }
  const columns = pickEnum(params.get('cols'), COLUMNS);
  if (columns) {
    state.columns = columns;
  }
  const xlimit = Number(params.get('xlimit'));
  if (Number.isInteger(xlimit) && xlimit > 0) {
    state.elapsedLimitHours = xlimit;
  }
  const baseline = params.get('baseline');
  if (baseline && JOB_ID_PATTERN.test(baseline)) {
    state.baselineJobId = baseline;
  }
  const mode = pickEnum(params.get('mode'), JOB_SET_MODES);
  if (mode) {
    state.jobSetMode = mode;
  }
  const picked = parseIdList(params.get('jobs'));
  if (picked) {
    state.pickedJobIds = picked;
  }
  const selected = parseIdList(params.get('sel'));
  if (selected) {
    state.selectedJobIds = selected;
  }
  return state;
}

export function buildCompareURLParams(
  view: CompareViewState,
  filters: Partial<SearchFilters>,
  timeRange: { from: string; to: string }
): URLSearchParams {
  const params = filtersToURLParams({ clusterId: '', ...filters, jobId: '' });
  if (timeRange.from && timeRange.to) {
    params.set('from', timeRange.from);
    params.set('to', timeRange.to);
  }
  viewStateToURLParams(view).forEach((value, key) => params.set(key, value));
  return params;
}

export function filtersFromCompareURLParams(params: URLSearchParams): Partial<SearchFilters> {
  const filters = filtersFromURLParams(params);
  delete filters.jobId;
  return filters;
}

export function buildCompareFromSearchParams(
  filters: SearchFilters,
  timeRange: { from: string; to: string },
  selectedJobIds: string[]
): URLSearchParams {
  const view: CompareViewState =
    selectedJobIds.length > 0
      ? { ...DEFAULT_VIEW_STATE, jobSetMode: 'pick', pickedJobIds: selectedJobIds }
      : DEFAULT_VIEW_STATE;
  return buildCompareURLParams(view, filters, timeRange);
}

export function buildCompareFromJobParams(
  job: Pick<JobRecord, 'clusterId' | 'jobId' | 'user' | 'name'>,
  metricName: string
): URLSearchParams {
  return buildCompareURLParams(
    { ...DEFAULT_VIEW_STATE, metric: metricName, baselineJobId: String(job.jobId) },
    { clusterId: job.clusterId, user: job.user, name: job.name },
    { from: COMPARE_FROM_JOB_RAW_FROM, to: DEFAULT_COMPARE_RAW_TO }
  );
}

export function toggleJobSelection(selected: string[], jobId: string): string[] {
  return selected.includes(jobId) ? selected.filter((id) => id !== jobId) : [...selected, jobId];
}
