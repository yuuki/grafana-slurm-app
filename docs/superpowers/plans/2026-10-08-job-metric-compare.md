# Job Metric Compare Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 1 つのメトリクスについて最大 48 ジョブの時系列をジョブごとに並べて比較・スクリーニングできる新ページ「Metric Compare」を追加する。

**Architecture:** フロントエンドのみの変更（バックエンドは既存の `GET /api/jobs` と `GET /api/jobs/{clusterId}/{jobId}` を使う）。ジョブ群のノード和集合に対して `avg/min/max by(instance)` を時間方向バッチで `query_range` し、クライアント側でジョブごとに切り出して 1 本に集約する。純関数（URL 状態、系列変換、乖離スコア、ビュー導出）と React コンポーネント（SVG チャート、グリッド、オーバーレイ、操作部）を分離し、ページは両者をつなぐだけにする。

**Tech Stack:** TypeScript, React 18, `@grafana/ui`, `@grafana/data`, `@grafana/runtime`（`getBackendSrv`）, `@grafana/scenes`（拡大モーダルのみ）, Jest + Testing Library（`@swc/jest`）。

**Spec:** `docs/superpowers/specs/2026-10-07-job-metric-compare-design.md`

## Global Constraints

- 比較ジョブ数の上限: `COMPARE_JOB_LIMIT = 48`。ページングも `Load more` も作らない。
- Overlay の線数上限: `OVERLAY_LINE_LIMIT = 10`。
- 乖離スコア用の再サンプリング点数: `PROFILE_BINS = 200`。1 点あたり最低 3 ジョブ（`MIN_JOBS_PER_POINT = 3`）。閾値は「スコア中央値 + 2×MAD」（`MAD_MULTIPLIER = 2`）。
- 既定のビュー状態: layout=`grid`, xAxis=`elapsed`, reduce=`band`, yScale=`shared`, sort=`deviation`, columns=`auto`, jobSetMode=`filter`。
- 既定の期間: Filter モードは `now-7d`〜`now`。Job Dashboard から来た場合は `now-30d`〜`now`、同ユーザー・同ジョブ名。
- ルート: `/a/yuuki-slurm-app/compare`。ナビ名 `Metric Compare`、icon `chart-line`、Job Search と Node Health の間。
- counter 型メトリクスは `rate(...[5m])` を適用する（既存 `RATE_WINDOW = '5m'` と同じ）。
- PromQL のラベル値・ラベル名は既存ヘルパー（`buildInstanceMatcher`, `buildFilterMatcher`, `formatLabelNameForDatasource`）で組み立てる。メトリクス名は `^[a-zA-Z_:][a-zA-Z0-9_:]*$` に一致しない限り使わない（URL から来るため）。
- UI 文言は英語・sentence case（既存 UI に合わせる）。コメントは既存コードと同程度に最小限。
- TypeScript 2 スペースインデント。コミットは `feat:` / `test:` / `docs:` プレフィックス。
- 各タスク完了時に `npx jest --testPathPatterns=<対象>` と `npm run typecheck` を通す。最終タスクで `npm test` / `npm run lint` / `npm run typecheck` 全体を通す。
- Jest は v30 のため、単体実行のフラグは `--testPathPatterns`（複数形）。この worktree（`.claude/worktrees/` 配下）では jest がテストを正常に発見できることを確認済み。

---

## File Structure

新規（すべて `src/pages/JobCompare/` 配下）:

| File | Responsibility |
|------|----------------|
| `model.ts` | ビュー状態の型・既定値・URL との相互変換・入口用 URL ビルダー・選択トグル |
| `seriesTransform.ts` | インスタンス別系列 → ジョブ別系列の切り出し、X 軸写像、ビン化、要約統計、カーソル値 |
| `deviation.ts` | 中央値プロファイルと乖離スコア（差し替え可能な `DeviationScorer`） |
| `metricQuery.ts` | PromQL 式生成、時間バッチ計画、step 計算、`fetchCompareSeries` |
| `metricCatalog.ts` | メトリクス名一覧・型取得、Suggested グループ化、拡大モーダル用エントリ |
| `jobSet.ts` | Filter/Pick モードのジョブ取得、GPU 除外、Baseline のマージ、期間の初期化 |
| `compareView.ts` | 上記を合成してセルモデル・軸ドメイン・並べ替えを導出する純関数 |
| `chartScale.ts` | SVG パス生成、ドメイン計算、X/値のフォーマット |
| `CompareChart.tsx` | SVG 時系列（線・帯・ベースライン・カーソル・マーカー） |
| `CompareCell.tsx` | 1 ジョブのセル |
| `CompareGrid.tsx` | small multiples と同期カーソル |
| `CompareOverlay.tsx` | 重ね描きと凡例テーブル |
| `CompareToolbar.tsx` | 表示オプション |
| `MetricPicker.tsx` | メトリクス選択 |
| `JobSetBar.tsx` | ジョブ集合の要約・編集・警告 |
| `JobDetailModal.tsx` | per-GPU 拡大表示（既存 Scenes 再利用） |
| `useCompareData.ts` | 系列取得のライフサイクル（キャンセル・リトライ） |
| `JobComparePage.tsx` | ページの組み立て |

変更:

| File | Change |
|------|--------|
| `src/constants.ts` | `ROUTES.Compare` と `buildCompareRoute` |
| `src/pages/JobSearch/jobMetrics.ts` | `matchesNode` と `queryRangePerInstanceStrict` を export |
| `src/pages/JobDashboard/scenes/metricDiscovery.ts` | `queryMetadataFromDatasource` を export |
| `src/storage/userPreferences.ts` | Compare ビューの前回状態保存 |
| `src/components/App/App.tsx` | ルーティング |
| `src/plugin.json` | ナビ項目 |
| `src/pages/JobSearch/JobTable.tsx`, `JobSearchPage.tsx`, `navigation.ts` | 行選択と `Compare metric` ボタン |
| `src/pages/JobDashboard/components/MetricExplorer.tsx`, `JobDashboardPage.tsx` | `Compare across jobs` ボタン |
| `docs/metric-compare.md`, `docs/overview.md`, `README.md` | ドキュメント |

---

### Task 1: ビュー状態モデルとルート定数

**Files:**
- Modify: `src/constants.ts`
- Create: `src/pages/JobCompare/model.ts`
- Test: `src/pages/JobCompare/model.test.ts`

**Interfaces:**
- Consumes: `SearchFilters`, `filtersToURLParams`, `filtersFromURLParams`（`src/pages/JobSearch/model.ts`）, `JobRecord`
- Produces:
  - `src/constants.ts`: `ROUTES.Compare = 'compare'`, `buildCompareRoute(params?: URLSearchParams): string`
  - `model.ts`: 定数 `COMPARE_JOB_LIMIT`, `OVERLAY_LINE_LIMIT`, `PROFILE_BINS`, `DEFAULT_COMPARE_RAW_FROM`, `DEFAULT_COMPARE_RAW_TO`, `COMPARE_FROM_JOB_RAW_FROM`
  - 型 `CompareLayout`, `CompareXAxis`, `CompareReduce`, `CompareYScale`, `CompareSort`, `CompareColumns`, `JobSetMode`, `CompareViewState`
  - `DEFAULT_VIEW_STATE: CompareViewState`
  - `isValidMetricName(name: string): boolean`
  - `viewStateToURLParams(state: CompareViewState): URLSearchParams`
  - `viewStateFromURLParams(params: URLSearchParams): Partial<CompareViewState>`
  - `buildCompareURLParams(view: CompareViewState, filters: Partial<SearchFilters>, timeRange: { from: string; to: string }): URLSearchParams`
  - `filtersFromCompareURLParams(params: URLSearchParams): Partial<SearchFilters>`（`jobId` を除いた検索フィルタ）
  - `buildCompareFromSearchParams(filters: SearchFilters, timeRange: { from: string; to: string }, selectedJobIds: string[]): URLSearchParams`
  - `buildCompareFromJobParams(job: Pick<JobRecord, 'clusterId' | 'jobId' | 'user' | 'name'>, metricName: string): URLSearchParams`
  - `toggleJobSelection(selected: string[], jobId: string): string[]`

- [ ] **Step 1: Write the failing test**

`src/pages/JobCompare/model.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --testPathPatterns=JobCompare/model.test`
Expected: FAIL（`Cannot find module './model'`）

- [ ] **Step 3: Write minimal implementation**

`src/constants.ts` を次のように変更:

```ts
export const PLUGIN_ID = 'yuuki-slurm-app';
export const PLUGIN_BASE_URL = `/a/${PLUGIN_ID}`;
export const ROUTES = {
  Jobs: 'jobs',
  Compare: 'compare',
} as const;

export function buildJobRoute(clusterId: string, jobId: string | number): string {
  return `${PLUGIN_BASE_URL}/${ROUTES.Jobs}/${clusterId}/${jobId}`;
}

export function buildCompareRoute(params?: URLSearchParams): string {
  const query = params?.toString();
  return `${PLUGIN_BASE_URL}/${ROUTES.Compare}${query ? `?${query}` : ''}`;
}
```

`src/pages/JobCompare/model.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --testPathPatterns=JobCompare/model.test && npm run typecheck`
Expected: PASS（9 tests）、typecheck エラーなし

- [ ] **Step 5: Commit**

```bash
git add src/constants.ts src/pages/JobCompare/model.ts src/pages/JobCompare/model.test.ts
git commit -m "feat: add metric compare view state model"
```

---

### Task 2: 系列変換（切り出し・軸写像・ビン化・統計）

**Files:**
- Modify: `src/pages/JobSearch/jobMetrics.ts`（`matchesNode` に `export` を付けるだけ）
- Create: `src/pages/JobCompare/seriesTransform.ts`
- Test: `src/pages/JobCompare/seriesTransform.test.ts`

**Interfaces:**
- Consumes: `matchesNode(instance: string, nodeSet: Set<string>, nodes: string[], mode: 'host:port' | 'hostname'): boolean`（`jobMetrics.ts`）、`CompareXAxis`, `CompareReduce`（Task 1）
- Produces:
  - 型 `Point = [number, number]`, `InstanceSeries = Map<string, Point[]>`, `InstanceSeriesSet = { mean; min; max }`, `JobSeries = { times: number[]; mean: number[]; min: number[]; max: number[] }`
  - `jobEndTime(job: Pick<JobRecord, 'endTime'>, now: number): number`
  - `sliceJobSeries(job: JobRecord, set: InstanceSeriesSet, mode: 'host:port' | 'hostname', now: number): JobSeries | null`
  - `reduceLine(series: JobSeries, reduce: CompareReduce): number[]`
  - `projectTimes(times: number[], job: Pick<JobRecord, 'startTime' | 'endTime'>, xAxis: CompareXAxis, now: number): number[]`
  - `binSeries(x: number[], y: number[], lo: number, hi: number, bins: number): number[]`
  - `summarize(values: number[]): { mean: number | undefined; p95: number | undefined }`
  - `valueAt(x: number[], y: number[], target: number): number | undefined`

- [ ] **Step 1: Write the failing test**

`src/pages/JobCompare/seriesTransform.test.ts`:

```ts
import { JobRecord } from '../../api/types';
import { binSeries, projectTimes, reduceLine, sliceJobSeries, summarize, valueAt } from './seriesTransform';

const job: JobRecord = {
  clusterId: 'a100',
  jobId: 1,
  name: 'train',
  user: 'alice',
  account: 'ml',
  partition: 'gpu',
  state: 'COMPLETED',
  nodes: ['gpu-node001', 'gpu-node002'],
  nodeList: 'gpu-node[001-002]',
  nodeCount: 2,
  gpusTotal: 16,
  submitTime: 900,
  startTime: 1000,
  endTime: 1200,
  exitCode: 0,
  workDir: '/tmp',
  tres: '',
  templateId: 'overview',
};

describe('sliceJobSeries', () => {
  it('averages means and takes extremes across the job nodes inside the job window', () => {
    const set = {
      mean: new Map([
        ['gpu-node001:9400', [[900, 99], [1000, 10], [1100, 20]] as Array<[number, number]>],
        ['gpu-node002:9400', [[1000, 30], [1100, 40], [1300, 99]] as Array<[number, number]>],
        ['gpu-node009:9400', [[1000, 500]] as Array<[number, number]>],
      ]),
      min: new Map([
        ['gpu-node001:9400', [[1000, 5], [1100, 15]] as Array<[number, number]>],
        ['gpu-node002:9400', [[1000, 25], [1100, 35]] as Array<[number, number]>],
      ]),
      max: new Map([
        ['gpu-node001:9400', [[1000, 15], [1100, 25]] as Array<[number, number]>],
        ['gpu-node002:9400', [[1000, 35], [1100, 45]] as Array<[number, number]>],
      ]),
    };
    expect(sliceJobSeries(job, set, 'host:port', 5000)).toEqual({
      times: [1000, 1100],
      mean: [20, 30],
      min: [5, 15],
      max: [35, 45],
    });
  });

  it('falls back to the mean when min/max series are missing and returns null without data', () => {
    const set = {
      mean: new Map([['gpu-node001', [[1000, 7]] as Array<[number, number]>]]),
      min: new Map(),
      max: new Map(),
    };
    expect(sliceJobSeries(job, set, 'hostname', 5000)).toEqual({ times: [1000], mean: [7], min: [7], max: [7] });
    expect(sliceJobSeries(job, { mean: new Map(), min: new Map(), max: new Map() }, 'hostname', 5000)).toBeNull();
  });

  it('uses now as the end of running jobs', () => {
    const running = { ...job, endTime: 0 };
    const set = { mean: new Map([['gpu-node001', [[1500, 1]] as Array<[number, number]>]]), min: new Map(), max: new Map() };
    expect(sliceJobSeries(running, set, 'hostname', 2000)?.times).toEqual([1500]);
    expect(sliceJobSeries(running, set, 'hostname', 1400)).toBeNull();
  });
});

describe('reduceLine and projectTimes', () => {
  const series = { times: [1000, 1100], mean: [1, 2], min: [0, 1], max: [2, 3] };

  it('selects the reduced line', () => {
    expect(reduceLine(series, 'mean')).toEqual([1, 2]);
    expect(reduceLine(series, 'band')).toEqual([1, 2]);
    expect(reduceLine(series, 'min')).toEqual([0, 1]);
    expect(reduceLine(series, 'max')).toEqual([2, 3]);
  });

  it('maps timestamps onto each x axis', () => {
    expect(projectTimes([1000, 1100, 1200], job, 'elapsed', 0)).toEqual([0, 100, 200]);
    expect(projectTimes([1000, 1100, 1200], job, 'progress', 0)).toEqual([0, 50, 100]);
    expect(projectTimes([1000, 1100], job, 'absolute', 0)).toEqual([1000, 1100]);
  });
});

describe('binSeries', () => {
  it('averages points per bin and leaves empty bins as NaN', () => {
    const out = binSeries([0, 10, 60, 100], [1, 3, 5, 7], 0, 100, 4);
    expect(out[0]).toBe(2);
    expect(Number.isNaN(out[1])).toBe(true);
    expect(out[2]).toBe(5);
    expect(out[3]).toBe(7);
  });

  it('returns all NaN for an empty range', () => {
    expect(binSeries([0], [1], 0, 0, 2).every(Number.isNaN)).toBe(true);
  });
});

describe('summarize and valueAt', () => {
  it('computes mean and p95 over finite values', () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(summarize([...values, NaN])).toEqual({ mean: 10.5, p95: 19 });
    expect(summarize([])).toEqual({ mean: undefined, p95: undefined });
  });

  it('returns the nearest value inside the x range', () => {
    expect(valueAt([0, 10, 20], [1, 2, 3], 12)).toBe(2);
    expect(valueAt([0, 10, 20], [1, 2, 3], 16)).toBe(3);
    expect(valueAt([0, 10, 20], [1, 2, 3], 25)).toBeUndefined();
    expect(valueAt([], [], 0)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --testPathPatterns=JobCompare/seriesTransform.test`
Expected: FAIL（`Cannot find module './seriesTransform'`）

- [ ] **Step 3: Write minimal implementation**

`src/pages/JobSearch/jobMetrics.ts` の `function matchesNode(` を `export function matchesNode(` に変更する（本体は変えない）。

`src/pages/JobCompare/seriesTransform.ts`:

```ts
import { JobRecord } from '../../api/types';
import { matchesNode } from '../JobSearch/jobMetrics';
import { CompareReduce, CompareXAxis } from './model';

export type Point = [number, number];
export type InstanceSeries = Map<string, Point[]>;

export interface InstanceSeriesSet {
  mean: InstanceSeries;
  min: InstanceSeries;
  max: InstanceSeries;
}

export interface JobSeries {
  times: number[];
  mean: number[];
  min: number[];
  max: number[];
}

interface Bucket {
  sum: number;
  count: number;
  min: number;
  max: number;
}

export function jobEndTime(job: Pick<JobRecord, 'endTime'>, now: number): number {
  return job.endTime > 0 ? job.endTime : now;
}

export function sliceJobSeries(
  job: JobRecord,
  set: InstanceSeriesSet,
  mode: 'host:port' | 'hostname',
  now: number
): JobSeries | null {
  const end = jobEndTime(job, now);
  const nodeSet = new Set(job.nodes);
  const buckets = new Map<number, Bucket>();

  const visit = (series: InstanceSeries, apply: (bucket: Bucket, value: number) => void) => {
    for (const [instance, points] of series) {
      if (!matchesNode(instance, nodeSet, job.nodes, mode)) {
        continue;
      }
      for (const [ts, value] of points) {
        if (ts < job.startTime || ts > end) {
          continue;
        }
        let bucket = buckets.get(ts);
        if (!bucket) {
          bucket = { sum: 0, count: 0, min: Infinity, max: -Infinity };
          buckets.set(ts, bucket);
        }
        apply(bucket, value);
      }
    }
  };

  visit(set.mean, (b, v) => {
    b.sum += v;
    b.count += 1;
  });
  visit(set.min, (b, v) => {
    b.min = Math.min(b.min, v);
  });
  visit(set.max, (b, v) => {
    b.max = Math.max(b.max, v);
  });

  const times = [...buckets.keys()].filter((ts) => buckets.get(ts)!.count > 0).sort((a, b) => a - b);
  if (times.length === 0) {
    return null;
  }
  const mean = times.map((ts) => {
    const b = buckets.get(ts)!;
    return b.sum / b.count;
  });
  return {
    times,
    mean,
    min: times.map((ts, i) => (Number.isFinite(buckets.get(ts)!.min) ? buckets.get(ts)!.min : mean[i])),
    max: times.map((ts, i) => (Number.isFinite(buckets.get(ts)!.max) ? buckets.get(ts)!.max : mean[i])),
  };
}

export function reduceLine(series: JobSeries, reduce: CompareReduce): number[] {
  switch (reduce) {
    case 'max':
      return series.max;
    case 'min':
      return series.min;
    default:
      return series.mean;
  }
}

export function projectTimes(
  times: number[],
  job: Pick<JobRecord, 'startTime' | 'endTime'>,
  xAxis: CompareXAxis,
  now: number
): number[] {
  switch (xAxis) {
    case 'elapsed':
      return times.map((ts) => ts - job.startTime);
    case 'progress': {
      const duration = Math.max(jobEndTime(job, now) - job.startTime, 1);
      return times.map((ts) => ((ts - job.startTime) / duration) * 100);
    }
    default:
      return times;
  }
}

export function binSeries(x: number[], y: number[], lo: number, hi: number, bins: number): number[] {
  const width = (hi - lo) / bins;
  if (!(width > 0)) {
    return new Array(bins).fill(NaN);
  }
  const sums = new Array(bins).fill(0);
  const counts = new Array(bins).fill(0);
  for (let i = 0; i < x.length; i++) {
    if (x[i] < lo || x[i] > hi || !Number.isFinite(y[i])) {
      continue;
    }
    const index = Math.min(bins - 1, Math.floor((x[i] - lo) / width));
    sums[index] += y[i];
    counts[index] += 1;
  }
  return sums.map((sum, i) => (counts[i] > 0 ? sum / counts[i] : NaN));
}

export function summarize(values: number[]): { mean: number | undefined; p95: number | undefined } {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) {
    return { mean: undefined, p95: undefined };
  }
  const mean = finite.reduce((a, b) => a + b, 0) / finite.length;
  const index = Math.min(finite.length - 1, Math.ceil(0.95 * finite.length) - 1);
  return { mean, p95: finite[index] };
}

export function valueAt(x: number[], y: number[], target: number): number | undefined {
  if (x.length === 0 || target < x[0] || target > x[x.length - 1]) {
    return undefined;
  }
  let lo = 0;
  let hi = x.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (x[mid] <= target) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return target - x[lo] <= x[hi] - target ? y[lo] : y[hi];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --testPathPatterns="JobCompare/seriesTransform.test|JobSearch/jobMetrics.test" && npm run typecheck`
Expected: PASS（既存 jobMetrics テストも PASS）

- [ ] **Step 5: Commit**

```bash
git add src/pages/JobSearch/jobMetrics.ts src/pages/JobCompare/seriesTransform.ts src/pages/JobCompare/seriesTransform.test.ts
git commit -m "feat: add per-job series slicing and axis projection for metric compare"
```

---

### Task 3: 乖離スコア

**Files:**
- Create: `src/pages/JobCompare/deviation.ts`
- Test: `src/pages/JobCompare/deviation.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - 定数 `MIN_JOBS_PER_POINT = 3`, `MAD_MULTIPLIER = 2`
  - 型 `DeviationResult = { score: number; signedMean: number; flagged: boolean }`
  - 型 `DeviationScorer = (profiles: Map<string, number[]>) => Map<string, DeviationResult>`（key は `jobKey`）
  - `median(values: number[]): number`
  - `medianProfile(profiles: number[][]): number[]`
  - `medianDeviationScorer: DeviationScorer`

- [ ] **Step 1: Write the failing test**

`src/pages/JobCompare/deviation.test.ts`:

```ts
import { median, medianDeviationScorer, medianProfile } from './deviation';

describe('median', () => {
  it('handles odd and even lengths', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

describe('medianProfile', () => {
  it('ignores points with fewer than three finite values', () => {
    const profile = medianProfile([
      [1, 1, NaN],
      [2, 5, NaN],
      [3, NaN, 9],
    ]);
    expect(profile[0]).toBe(2);
    expect(Number.isNaN(profile[1])).toBe(true);
    expect(Number.isNaN(profile[2])).toBe(true);
  });
});

describe('medianDeviationScorer', () => {
  const flat = (v: number) => [v, v, v, v];

  it('scores distance from the median profile and flags the outlier', () => {
    const result = medianDeviationScorer(
      new Map([
        ['a', flat(60)],
        ['b', flat(61)],
        ['c', flat(59)],
        ['d', flat(60)],
        ['e', flat(20)],
      ])
    );
    expect(result.get('e')).toEqual({ score: 40, signedMean: -40, flagged: true });
    expect(result.get('a')?.flagged).toBe(false);
    expect(result.get('b')).toEqual({ score: 1, signedMean: 1, flagged: false });
  });

  it('skips jobs without overlapping points and does not flag with fewer than three jobs', () => {
    const result = medianDeviationScorer(
      new Map([
        ['a', [1, NaN]],
        ['b', [9, NaN]],
        ['c', [NaN, NaN]],
      ])
    );
    expect(result.has('c')).toBe(false);
    expect([...result.values()].some((r) => r.flagged)).toBe(false);
  });
});
```

注: 2 つ目のテストでは有効点を持つジョブが 2 つしかないため、中央値プロファイル自体が NaN になり `a` と `b` もスコアを持たない（`result.size === 0`）。`has('c') === false` と「どれも flagged でない」を確認する。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --testPathPatterns=JobCompare/deviation.test`
Expected: FAIL（`Cannot find module './deviation'`）

- [ ] **Step 3: Write minimal implementation**

`src/pages/JobCompare/deviation.ts`:

```ts
export const MIN_JOBS_PER_POINT = 3;
export const MAD_MULTIPLIER = 2;

export interface DeviationResult {
  score: number;
  signedMean: number;
  flagged: boolean;
}

// Profiles are keyed by jobKey and resampled onto a common grid.
// Phase 2 scorers (DTW, change-point position, ...) plug in through this signature.
export type DeviationScorer = (profiles: Map<string, number[]>) => Map<string, DeviationResult>;

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function medianProfile(profiles: number[][]): number[] {
  const length = profiles.reduce((max, p) => Math.max(max, p.length), 0);
  return Array.from({ length }, (_, i) => {
    const values = profiles.map((p) => p[i]).filter(Number.isFinite);
    return values.length >= MIN_JOBS_PER_POINT ? median(values) : NaN;
  });
}

export const medianDeviationScorer: DeviationScorer = (profiles) => {
  const result = new Map<string, DeviationResult>();
  const center = medianProfile([...profiles.values()]);

  for (const [key, profile] of profiles) {
    let absSum = 0;
    let signedSum = 0;
    let count = 0;
    profile.forEach((value, i) => {
      const m = center[i];
      if (!Number.isFinite(value) || !Number.isFinite(m)) {
        return;
      }
      absSum += Math.abs(value - m);
      signedSum += value - m;
      count += 1;
    });
    if (count > 0) {
      result.set(key, { score: absSum / count, signedMean: signedSum / count, flagged: false });
    }
  }

  const scores = [...result.values()].map((r) => r.score);
  if (scores.length >= MIN_JOBS_PER_POINT) {
    const med = median(scores);
    const mad = median(scores.map((s) => Math.abs(s - med)));
    const threshold = med + MAD_MULTIPLIER * mad;
    for (const r of result.values()) {
      r.flagged = r.score > threshold + 1e-9;
    }
  }
  return result;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --testPathPatterns=JobCompare/deviation.test && npm run typecheck`
Expected: PASS

確認: 1 つ目のテストでは、中央値プロファイルは各点で `median(60,61,59,60,20)=60` なので a=0, b=1, c=1, d=0, e=40。スコア中央値 = 1、MAD = median(|0-1|,|1-1|,|1-1|,|0-1|,|40-1|) = 1、閾値 = 3 → e のみ flagged。テストの期待値と一致する。

- [ ] **Step 5: Commit**

```bash
git add src/pages/JobCompare/deviation.ts src/pages/JobCompare/deviation.test.ts
git commit -m "feat: add median-profile deviation scoring for metric compare"
```

---

### Task 4: PromQL 生成・バッチ計画・系列取得

**Files:**
- Modify: `src/pages/JobSearch/jobMetrics.ts`（`queryRangePerInstance` を「例外を投げる版」と「握りつぶす版」に分割）
- Create: `src/pages/JobCompare/metricQuery.ts`
- Test: `src/pages/JobCompare/metricQuery.test.ts`

**Interfaces:**
- Consumes: `buildInstanceMatcher`, `buildFilterMatcher`, `formatLabelNameForDatasource`（`scenes/model.ts`）、`jobKey`（`JobSearch/model.ts`）、`sliceJobSeries`, `jobEndTime`, `JobSeries`, `InstanceSeries`（Task 2）、`PrometheusMetricType`（`metricDiscovery.ts`）
- Produces:
  - `jobMetrics.ts`: `export async function queryRangePerInstanceStrict(datasourceUid: string, expr: string, start: number, end: number, step: number, instanceLabel: string): Promise<Map<string, Array<[number, number]>>>`（HTTP エラーで throw）
  - `metricQuery.ts`:
    - 定数 `RATE_WINDOW = '5m'`, `BATCH_GAP_SECONDS = 6 * 3600`
    - `buildCompareExprs(metricName: string, metricType: PrometheusMetricType, matcher: string, byLabel: string): { mean: string; min: string; max: string }`
    - 型 `QueryBatch = { jobs: JobRecord[]; start: number; end: number }`
    - `planQueryBatches(jobs: JobRecord[], now: number, gap?: number): QueryBatch[]`
    - `computeStep(batch: QueryBatch, now: number): number`
    - 型 `CompareFetchResult = { series: Map<string, JobSeries>; failedJobKeys: Set<string> }`
    - `fetchCompareSeries(args: { jobs: JobRecord[]; cluster: ClusterSummary; metricName: string; metricType: PrometheusMetricType; now: number }): Promise<CompareFetchResult>`

- [ ] **Step 1: Write the failing test**

`src/pages/JobCompare/metricQuery.test.ts`:

```ts
import { of, throwError } from 'rxjs';

const mockFetch = jest.fn();

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({ fetch: mockFetch }),
}));

import { ClusterSummary, JobRecord } from '../../api/types';
import { buildCompareExprs, computeStep, fetchCompareSeries, planQueryBatches } from './metricQuery';

const cluster: ClusterSummary = {
  id: 'a100',
  displayName: 'A100',
  slurmClusterName: 'slurm-a100',
  metricsDatasourceUid: 'prom-main',
  metricsType: 'prometheus',
  aggregationNodeLabels: ['instance'],
  instanceLabel: 'instance',
  nodeMatcherMode: 'hostname',
  defaultTemplateId: 'overview',
  metricsFilterLabel: 'cluster',
  metricsFilterValue: 'slurm-a100',
};

function makeJob(jobId: number, node: string, startTime: number, endTime: number): JobRecord {
  return {
    clusterId: 'a100',
    jobId,
    name: 'train',
    user: 'alice',
    account: 'ml',
    partition: 'gpu',
    state: endTime > 0 ? 'COMPLETED' : 'RUNNING',
    nodes: [node],
    nodeList: node,
    nodeCount: 1,
    gpusTotal: 8,
    submitTime: startTime,
    startTime,
    endTime,
    exitCode: 0,
    workDir: '/tmp',
    tres: '',
    templateId: 'overview',
  };
}

function matrix(items: Array<{ instance: string; values: Array<[number, string]> }>) {
  return of({
    data: {
      data: { result: items.map((item) => ({ metric: { instance: item.instance }, values: item.values })) },
    },
  });
}

describe('buildCompareExprs', () => {
  it('aggregates gauges per instance', () => {
    expect(buildCompareExprs('DCGM_FI_DEV_GPU_UTIL', 'gauge', 'instance=~"(n1)"', 'instance')).toEqual({
      mean: 'avg by(instance) (DCGM_FI_DEV_GPU_UTIL{instance=~"(n1)"})',
      min: 'min by(instance) (DCGM_FI_DEV_GPU_UTIL{instance=~"(n1)"})',
      max: 'max by(instance) (DCGM_FI_DEV_GPU_UTIL{instance=~"(n1)"})',
    });
  });

  it('applies rate() to counters', () => {
    expect(buildCompareExprs('node_network_receive_bytes_total', 'counter', 'a="b"', 'instance').mean).toBe(
      'avg by(instance) (rate(node_network_receive_bytes_total{a="b"}[5m]))'
    );
  });
});

describe('planQueryBatches', () => {
  it('merges jobs whose windows are close and splits distant ones', () => {
    const batches = planQueryBatches(
      [
        makeJob(3, 'n3', 100_000, 103_600),
        makeJob(1, 'n1', 1000, 4600),
        makeJob(2, 'n2', 5000, 8000),
        makeJob(4, 'n4', 0, 0),
      ],
      200_000
    );
    expect(batches.map((b) => b.jobs.map((j) => j.jobId))).toEqual([[1, 2], [3]]);
    expect(batches[0]).toMatchObject({ start: 1000, end: 8000 });
  });
});

describe('computeStep', () => {
  it('targets about 200 points for the shortest job with a 15s floor', () => {
    const batch = { jobs: [makeJob(1, 'n1', 0, 40_000)], start: 0, end: 40_000 };
    expect(computeStep(batch, 0)).toBe(200);
    const short = { jobs: [makeJob(1, 'n1', 0, 600)], start: 0, end: 600 };
    expect(computeStep(short, 0)).toBe(15);
  });

  it('stays under the Prometheus 11000 points limit', () => {
    const batch = { jobs: [makeJob(1, 'n1', 0, 600), makeJob(2, 'n2', 0, 1_000_000)], start: 0, end: 1_000_000 };
    expect(computeStep(batch, 0)).toBe(91);
  });
});

describe('fetchCompareSeries', () => {
  beforeEach(() => mockFetch.mockReset());

  it('queries mean/min/max once per batch and slices each job', async () => {
    mockFetch.mockImplementation((req: { data: string }) => {
      const query = new URLSearchParams(req.data).get('query') ?? '';
      const offset = query.startsWith('min') ? -1 : query.startsWith('max') ? 1 : 0;
      return matrix([
        { instance: 'n1', values: [[1000, String(10 + offset)], [2000, String(20 + offset)]] },
        { instance: 'n2', values: [[5000, String(30 + offset)]] },
      ]);
    });
    const result = await fetchCompareSeries({
      jobs: [makeJob(1, 'n1', 1000, 4600), makeJob(2, 'n2', 5000, 8000)],
      cluster,
      metricName: 'DCGM_FI_DEV_GPU_UTIL',
      metricType: 'gauge',
      now: 10_000,
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);
    const firstQuery = new URLSearchParams(mockFetch.mock.calls[0][0].data).get('query');
    expect(firstQuery).toContain('instance=~"(n1|n2)"');
    expect(firstQuery).toContain('cluster="slurm-a100"');
    expect(result.series.get('a100-1')).toEqual({ times: [1000, 2000], mean: [10, 20], min: [9, 19], max: [11, 21] });
    expect(result.series.get('a100-2')?.mean).toEqual([30]);
    expect(result.failedJobKeys.size).toBe(0);
  });

  it('marks every job in a failed batch as failed', async () => {
    mockFetch.mockReturnValue(throwError(() => ({ status: 422 })));
    const result = await fetchCompareSeries({
      jobs: [makeJob(1, 'n1', 1000, 4600)],
      cluster,
      metricName: 'up',
      metricType: 'gauge',
      now: 10_000,
    });
    expect([...result.failedJobKeys]).toEqual(['a100-1']);
    expect(result.series.size).toBe(0);
  });

  it('fails every job when the cluster has no metrics datasource', async () => {
    const result = await fetchCompareSeries({
      jobs: [makeJob(1, 'n1', 1000, 4600)],
      cluster: { ...cluster, metricsDatasourceUid: '' },
      metricName: 'up',
      metricType: 'gauge',
      now: 10_000,
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect([...result.failedJobKeys]).toEqual(['a100-1']);
  });
});
```

`computeStep` の期待値の根拠: 1 つ目は `max(15, ceil(40000/11000)=4, floor(40000/200)=200) = 200`。3 つ目は `max(15, ceil(1000000/11000)=91, floor(600/200)=3) = 91`。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --testPathPatterns=JobCompare/metricQuery.test`
Expected: FAIL（`Cannot find module './metricQuery'`）

- [ ] **Step 3: Write minimal implementation**

`src/pages/JobSearch/jobMetrics.ts` の `queryRangePerInstance` を次の 2 関数に置き換える（呼び出し側の `fetchJobsUtilizationBatch` は変更不要）:

```ts
export async function queryRangePerInstanceStrict(
  datasourceUid: string,
  expr: string,
  start: number,
  end: number,
  step: number,
  instanceLabel: string
): Promise<Map<string, TimeSeries>> {
  const params = new URLSearchParams();
  params.set('query', expr);
  params.set('start', String(start));
  params.set('end', String(end));
  params.set('step', `${step}s`);

  const res = await lastValueFrom(
    getBackendSrv().fetch<{
      data?: {
        result?: Array<{
          metric?: Record<string, string>;
          values?: Array<[number, string]>;
        }>;
      };
    }>({
      url: `/api/datasources/proxy/uid/${datasourceUid}/api/v1/query_range`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: params.toString(),
    })
  );
  const response = res.data;
  const map = new Map<string, TimeSeries>();
  for (const item of response?.data?.result ?? []) {
    const instanceValue = item.metric?.[instanceLabel];
    if (!instanceValue) {
      continue;
    }
    const series: TimeSeries = [];
    for (const [ts, raw] of item.values ?? []) {
      const parsed = parseFloat(raw);
      if (!isNaN(parsed)) {
        series.push([ts, parsed]);
      }
    }
    if (series.length > 0) {
      map.set(instanceValue, series);
    }
  }
  return map;
}

async function queryRangePerInstance(
  datasourceUid: string,
  expr: string,
  start: number,
  end: number,
  step: number,
  instanceLabel: string
): Promise<Map<string, TimeSeries>> {
  try {
    return await queryRangePerInstanceStrict(datasourceUid, expr, start, end, step, instanceLabel);
  } catch {
    return new Map();
  }
}
```

`src/pages/JobCompare/metricQuery.ts`:

```ts
import { ClusterSummary, JobRecord } from '../../api/types';
import { buildFilterMatcher, buildInstanceMatcher, formatLabelNameForDatasource } from '../JobDashboard/scenes/model';
import { PrometheusMetricType } from '../JobDashboard/scenes/metricDiscovery';
import { queryRangePerInstanceStrict } from '../JobSearch/jobMetrics';
import { jobKey } from '../JobSearch/model';
import { jobEndTime, JobSeries, sliceJobSeries } from './seriesTransform';

export const RATE_WINDOW = '5m';
export const BATCH_GAP_SECONDS = 6 * 3600;
const MAX_POINTS_PER_SERIES = 11000;
const TARGET_POINTS_PER_JOB = 200;
const MIN_STEP_SECONDS = 15;

export function buildCompareExprs(
  metricName: string,
  metricType: PrometheusMetricType,
  matcher: string,
  byLabel: string
): { mean: string; min: string; max: string } {
  const base = metricType === 'counter' ? `rate(${metricName}{${matcher}}[${RATE_WINDOW}])` : `${metricName}{${matcher}}`;
  return {
    mean: `avg by(${byLabel}) (${base})`,
    min: `min by(${byLabel}) (${base})`,
    max: `max by(${byLabel}) (${base})`,
  };
}

export interface QueryBatch {
  jobs: JobRecord[];
  start: number;
  end: number;
}

export function planQueryBatches(jobs: JobRecord[], now: number, gap = BATCH_GAP_SECONDS): QueryBatch[] {
  const sorted = jobs.filter((j) => j.nodes.length > 0 && j.startTime > 0).sort((a, b) => a.startTime - b.startTime);
  const batches: QueryBatch[] = [];
  for (const job of sorted) {
    const end = jobEndTime(job, now);
    const last = batches[batches.length - 1];
    if (last && job.startTime <= last.end + gap) {
      last.jobs.push(job);
      last.end = Math.max(last.end, end);
    } else {
      batches.push({ jobs: [job], start: job.startTime, end });
    }
  }
  return batches;
}

export function computeStep(batch: QueryBatch, now: number): number {
  const range = Math.max(batch.end - batch.start, 1);
  const shortest = Math.min(...batch.jobs.map((j) => Math.max(jobEndTime(j, now) - j.startTime, 1)));
  return Math.max(
    MIN_STEP_SECONDS,
    Math.ceil(range / MAX_POINTS_PER_SERIES),
    Math.floor(shortest / TARGET_POINTS_PER_JOB)
  );
}

export interface CompareFetchResult {
  series: Map<string, JobSeries>;
  failedJobKeys: Set<string>;
}

export async function fetchCompareSeries({
  jobs,
  cluster,
  metricName,
  metricType,
  now,
}: {
  jobs: JobRecord[];
  cluster: ClusterSummary;
  metricName: string;
  metricType: PrometheusMetricType;
  now: number;
}): Promise<CompareFetchResult> {
  const result: CompareFetchResult = { series: new Map(), failedJobKeys: new Set() };
  if (!cluster.metricsDatasourceUid) {
    jobs.forEach((job) => result.failedJobKeys.add(jobKey(job.clusterId, job.jobId)));
    return result;
  }

  const filterMatcher = buildFilterMatcher(cluster.metricsFilterLabel, cluster.metricsFilterValue, cluster.metricsType);
  const byLabel = formatLabelNameForDatasource(cluster.instanceLabel, cluster.metricsType);

  // Batches run one after another so a 48-job page never fans out into parallel heavy queries.
  for (const batch of planQueryBatches(jobs, now)) {
    const nodes = [...new Set(batch.jobs.flatMap((j) => j.nodes))];
    const instanceMatcher = buildInstanceMatcher(nodes, cluster.instanceLabel, cluster.nodeMatcherMode, cluster.metricsType);
    const matcher = [instanceMatcher, filterMatcher].filter(Boolean).join(',');
    const exprs = buildCompareExprs(metricName, metricType, matcher, byLabel);
    const step = computeStep(batch, now);
    try {
      const [mean, min, max] = await Promise.all(
        [exprs.mean, exprs.min, exprs.max].map((expr) =>
          queryRangePerInstanceStrict(cluster.metricsDatasourceUid, expr, batch.start, batch.end, step, cluster.instanceLabel)
        )
      );
      for (const job of batch.jobs) {
        const series = sliceJobSeries(job, { mean, min, max }, cluster.nodeMatcherMode, now);
        if (series) {
          result.series.set(jobKey(job.clusterId, job.jobId), series);
        }
      }
    } catch {
      batch.jobs.forEach((job) => result.failedJobKeys.add(jobKey(job.clusterId, job.jobId)));
    }
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --testPathPatterns="JobCompare/metricQuery.test|JobSearch/jobMetrics.test" && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pages/JobSearch/jobMetrics.ts src/pages/JobCompare/metricQuery.ts src/pages/JobCompare/metricQuery.test.ts
git commit -m "feat: add batched per-job metric queries for metric compare"
```

---
### Task 5: メトリクスカタログ

**Files:**
- Modify: `src/pages/JobDashboard/scenes/metricDiscovery.ts`（`async function queryMetadataFromDatasource` に `export` を付けるだけ）
- Create: `src/pages/JobCompare/metricCatalog.ts`
- Test: `src/pages/JobCompare/metricCatalog.test.ts`

**Interfaces:**
- Consumes: `queryMetadataFromDatasource({ datasourceUid }): Promise<Map<string, PrometheusMetricType>>`, `inferMetricTypeFromName`, `getMetricEntryByKey`, `buildRawMetricKey`, `MetricExplorerEntry`（`metricDiscovery.ts`）、`buildFilterMatcher`、`isValidMetricName`（Task 1）
- Produces:
  - `SUGGESTED_METRICS: string[]`
  - `isGpuMetric(name: string): boolean`
  - `listMetricNames(cluster: ClusterSummary, range: { from: number; to: number }): Promise<string[]>`
  - `fetchMetricTypes(cluster: ClusterSummary): Promise<Map<string, PrometheusMetricType>>`（失敗時は空 Map）
  - `resolveMetricType(name: string, types: Map<string, PrometheusMetricType>): PrometheusMetricType`
  - `buildMetricOptions(names: string[]): Array<SelectableValue<string>>`（`Suggested` / `All metrics` のグループ）
  - `buildCompareMetricEntry(metricName: string, metricType: PrometheusMetricType): MetricExplorerEntry`

- [ ] **Step 1: Write the failing test**

`src/pages/JobCompare/metricCatalog.test.ts`:

```ts
const mockGet = jest.fn();

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({ get: mockGet }),
}));

import { ClusterSummary } from '../../api/types';
import {
  buildCompareMetricEntry,
  buildMetricOptions,
  fetchMetricTypes,
  isGpuMetric,
  listMetricNames,
  resolveMetricType,
} from './metricCatalog';

const cluster: ClusterSummary = {
  id: 'a100',
  displayName: 'A100',
  slurmClusterName: 'slurm-a100',
  metricsDatasourceUid: 'prom-main',
  metricsType: 'prometheus',
  aggregationNodeLabels: ['instance'],
  instanceLabel: 'instance',
  nodeMatcherMode: 'hostname',
  defaultTemplateId: 'overview',
  metricsFilterLabel: 'cluster',
  metricsFilterValue: 'slurm-a100',
};

describe('metric catalog', () => {
  beforeEach(() => mockGet.mockReset());

  it('lists metric names scoped by the cluster filter and time range', async () => {
    mockGet.mockResolvedValue({ data: ['node_load1', 'DCGM_FI_DEV_GPU_UTIL', 'bad{name}'] });
    const names = await listMetricNames(cluster, { from: 100, to: 200 });
    expect(names).toEqual(['DCGM_FI_DEV_GPU_UTIL', 'node_load1']);
    const url: string = mockGet.mock.calls[0][0];
    expect(url.startsWith('/api/datasources/proxy/uid/prom-main/api/v1/label/__name__/values?')).toBe(true);
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('match[]')).toBe('{cluster="slurm-a100"}');
    expect(params.get('start')).toBe('100');
    expect(params.get('end')).toBe('200');
  });

  it('returns no names without a datasource', async () => {
    expect(await listMetricNames({ ...cluster, metricsDatasourceUid: '' }, { from: 0, to: 1 })).toEqual([]);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('reads metric types from metadata and falls back to the name', async () => {
    mockGet.mockResolvedValue({ data: { node_load1: [{ type: 'gauge' }] } });
    const types = await fetchMetricTypes(cluster);
    expect(resolveMetricType('node_load1', types)).toBe('gauge');
    expect(resolveMetricType('node_network_receive_bytes_total', types)).toBe('counter');
    mockGet.mockRejectedValue(new Error('boom'));
    expect((await fetchMetricTypes(cluster)).size).toBe(0);
  });

  it('groups suggested metrics first', () => {
    expect(buildMetricOptions(['zzz_metric', 'node_load1', 'DCGM_FI_DEV_GPU_UTIL'])).toEqual([
      {
        label: 'Suggested',
        options: [
          { label: 'DCGM_FI_DEV_GPU_UTIL', value: 'DCGM_FI_DEV_GPU_UTIL' },
          { label: 'node_load1', value: 'node_load1' },
        ],
      },
      { label: 'All metrics', options: [{ label: 'zzz_metric', value: 'zzz_metric' }] },
    ]);
  });

  it('detects GPU metrics and builds per-GPU preview entries', () => {
    expect(isGpuMetric('DCGM_FI_PROF_PIPE_TENSOR_ACTIVE')).toBe(true);
    expect(isGpuMetric('node_load1')).toBe(false);
    expect(buildCompareMetricEntry('DCGM_FI_DEV_GPU_UTIL', 'gauge')).toMatchObject({
      metricName: 'DCGM_FI_DEV_GPU_UTIL',
      metricType: 'gauge',
      legendFormat: '{{instance}} / GPU {{gpu}}',
    });
    expect(buildCompareMetricEntry('node_load1', 'gauge').legendFormat).toBe('{{instance}}');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --testPathPatterns=JobCompare/metricCatalog.test`
Expected: FAIL（`Cannot find module './metricCatalog'`）

- [ ] **Step 3: Write minimal implementation**

`src/pages/JobDashboard/scenes/metricDiscovery.ts` の `async function queryMetadataFromDatasource(` を `export async function queryMetadataFromDatasource(` に変更する。

`src/pages/JobCompare/metricCatalog.ts`:

```ts
import { SelectableValue } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import { ClusterSummary } from '../../api/types';
import {
  buildRawMetricKey,
  getMetricEntryByKey,
  inferMetricTypeFromName,
  MetricExplorerEntry,
  PrometheusMetricType,
  queryMetadataFromDatasource,
} from '../JobDashboard/scenes/metricDiscovery';
import { buildFilterMatcher } from '../JobDashboard/scenes/model';
import { isValidMetricName } from './model';

export const SUGGESTED_METRICS: string[] = [
  'DCGM_FI_PROF_PIPE_TENSOR_ACTIVE',
  'DCGM_FI_PROF_SM_ACTIVE',
  'DCGM_FI_PROF_DRAM_ACTIVE',
  'DCGM_FI_DEV_GPU_UTIL',
  'DCGM_FI_DEV_FB_USED',
  'DCGM_FI_DEV_POWER_USAGE',
  'DCGM_FI_DEV_GPU_TEMP',
  'DCGM_FI_PROF_NVLINK_TX_BYTES',
  'DCGM_FI_PROF_NVLINK_RX_BYTES',
  'node_load1',
  'node_network_receive_bytes_total',
  'node_infiniband_port_data_received_bytes_total',
];

export function isGpuMetric(name: string): boolean {
  return name.startsWith('DCGM_');
}

export async function listMetricNames(cluster: ClusterSummary, range: { from: number; to: number }): Promise<string[]> {
  if (!cluster.metricsDatasourceUid) {
    return [];
  }
  const params = new URLSearchParams();
  const filter = buildFilterMatcher(cluster.metricsFilterLabel, cluster.metricsFilterValue, cluster.metricsType);
  if (filter) {
    params.append('match[]', `{${filter}}`);
  }
  params.set('start', String(range.from));
  params.set('end', String(range.to));
  const response = await getBackendSrv().get<{ data?: string[] }>(
    `/api/datasources/proxy/uid/${cluster.metricsDatasourceUid}/api/v1/label/__name__/values?${params.toString()}`
  );
  return (response?.data ?? []).filter(isValidMetricName).sort();
}

export async function fetchMetricTypes(cluster: ClusterSummary): Promise<Map<string, PrometheusMetricType>> {
  if (!cluster.metricsDatasourceUid) {
    return new Map();
  }
  try {
    return await queryMetadataFromDatasource({ datasourceUid: cluster.metricsDatasourceUid });
  } catch {
    return new Map();
  }
}

export function resolveMetricType(name: string, types: Map<string, PrometheusMetricType>): PrometheusMetricType {
  const known = types.get(name);
  return known && known !== 'unknown' ? known : inferMetricTypeFromName(name);
}

function toOption(name: string): SelectableValue<string> {
  return { label: name, value: name };
}

export function buildMetricOptions(names: string[]): Array<SelectableValue<string>> {
  const available = new Set(names);
  const suggested = SUGGESTED_METRICS.filter((name) => available.has(name));
  const suggestedSet = new Set(suggested);
  const others = names.filter((name) => !suggestedSet.has(name));
  const groups: Array<SelectableValue<string>> = [];
  if (suggested.length > 0) {
    groups.push({ label: 'Suggested', options: suggested.map(toOption) });
  }
  groups.push({ label: 'All metrics', options: others.map(toOption) });
  return groups;
}

export function buildCompareMetricEntry(metricName: string, metricType: PrometheusMetricType): MetricExplorerEntry {
  const base = getMetricEntryByKey(buildRawMetricKey(metricName))!;
  const gpu = isGpuMetric(metricName);
  return {
    ...base,
    metricType,
    labelKeys: gpu ? ['gpu', 'instance'] : ['instance'],
    legendFormat: gpu ? '{{instance}} / GPU {{gpu}}' : '{{instance}}',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --testPathPatterns="JobCompare/metricCatalog.test|metricDiscovery.test" && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pages/JobDashboard/scenes/metricDiscovery.ts src/pages/JobCompare/metricCatalog.ts src/pages/JobCompare/metricCatalog.test.ts
git commit -m "feat: add metric catalog for metric compare"
```

---

### Task 6: ジョブ集合の取得と前回状態の保存

**Files:**
- Create: `src/pages/JobCompare/jobSet.ts`
- Test: `src/pages/JobCompare/jobSet.test.ts`
- Modify: `src/storage/userPreferences.ts`
- Test: `src/storage/userPreferences.test.ts`（テスト追加）

**Interfaces:**
- Consumes: `listJobs`, `getJob`（`src/api/slurmApi.ts`）、`buildListJobsParams`, `timelineRangeFromURLParams`, `SearchFilters`（`JobSearch/model.ts`）、`makeRelativeTimeRange`（`JobSearch/timelineRange.ts`）、`isGpuMetric`（Task 5）、`COMPARE_JOB_LIMIT`, `DEFAULT_COMPARE_RAW_FROM`, `DEFAULT_COMPARE_RAW_TO`, `CompareViewState`, `viewStateToURLParams`, `viewStateFromURLParams`（Task 1）
- Produces:
  - `loadCompareTimeRange(params: URLSearchParams): TimeRange`
  - `loadFilterJobSet(filters: SearchFilters, range: { from: number; to: number }): Promise<{ jobs: JobRecord[]; total: number }>`
  - `loadPickedJobs(clusterId: string, ids: string[]): Promise<{ jobs: JobRecord[]; missingIds: string[] }>`
  - `finalizeJobSet(jobs: JobRecord[], options: { metric: string; baseline: JobRecord | null }): { jobs: JobRecord[]; hiddenNonGpu: number }`
  - `userPreferences.ts`: `loadCompareViewPreferences(): Partial<CompareViewState>`, `saveCompareViewPreferences(view: CompareViewState): void`

- [ ] **Step 1: Write the failing tests**

`src/pages/JobCompare/jobSet.test.ts`:

```ts
import { getJob, listJobs } from '../../api/slurmApi';
import { JobRecord } from '../../api/types';
import { finalizeJobSet, loadCompareTimeRange, loadFilterJobSet, loadPickedJobs } from './jobSet';

jest.mock('../../api/slurmApi', () => ({
  listJobs: jest.fn(),
  getJob: jest.fn(),
}));

const mockedListJobs = listJobs as jest.MockedFunction<typeof listJobs>;
const mockedGetJob = getJob as jest.MockedFunction<typeof getJob>;

function makeJob(jobId: number, gpusTotal = 8): JobRecord {
  return {
    clusterId: 'a100',
    jobId,
    name: 'train',
    user: 'alice',
    account: 'ml',
    partition: 'gpu',
    state: 'COMPLETED',
    nodes: ['n1'],
    nodeList: 'n1',
    nodeCount: 1,
    gpusTotal,
    submitTime: 1000,
    startTime: 1000 + jobId,
    endTime: 5000,
    exitCode: 0,
    workDir: '/tmp',
    tres: '',
    templateId: 'overview',
  };
}

describe('job set loading', () => {
  beforeEach(() => {
    mockedListJobs.mockReset();
    mockedGetJob.mockReset();
  });

  it('requests at most 48 jobs for the filter', async () => {
    mockedListJobs.mockResolvedValue({ jobs: [makeJob(1)], total: 213 });
    const result = await loadFilterJobSet({ clusterId: 'a100', user: 'alice' }, { from: 10, to: 20 });
    expect(mockedListJobs).toHaveBeenCalledWith(
      expect.objectContaining({ clusterId: 'a100', user: 'alice', from: 10, to: 20, limit: 48 })
    );
    expect(result).toEqual({ jobs: [makeJob(1)], total: 213 });
  });

  it('loads picked jobs and reports the missing ones', async () => {
    mockedGetJob.mockImplementation(async (_cluster, id) => {
      if (id === '2') {
        throw new Error('not found');
      }
      return makeJob(Number(id));
    });
    const result = await loadPickedJobs('a100', ['1', '2', '3']);
    expect(result.jobs.map((j) => j.jobId)).toEqual([1, 3]);
    expect(result.missingIds).toEqual(['2']);
  });

  it('caps picked jobs at 48', async () => {
    mockedGetJob.mockImplementation(async (_cluster, id) => makeJob(Number(id)));
    const ids = Array.from({ length: 60 }, (_, i) => String(i + 1));
    const result = await loadPickedJobs('a100', ids);
    expect(result.jobs).toHaveLength(48);
    expect(mockedGetJob).toHaveBeenCalledTimes(48);
  });
});

describe('finalizeJobSet', () => {
  it('hides jobs without GPUs for GPU metrics', () => {
    const result = finalizeJobSet([makeJob(1), makeJob(2, 0)], { metric: 'DCGM_FI_DEV_GPU_UTIL', baseline: null });
    expect(result.jobs.map((j) => j.jobId)).toEqual([1]);
    expect(result.hiddenNonGpu).toBe(1);
    expect(finalizeJobSet([makeJob(2, 0)], { metric: 'node_load1', baseline: null }).hiddenNonGpu).toBe(0);
  });

  it('always includes the baseline and keeps the 48 cap', () => {
    const jobs = Array.from({ length: 48 }, (_, i) => makeJob(i + 1));
    const baseline = makeJob(999);
    const result = finalizeJobSet(jobs, { metric: 'node_load1', baseline });
    expect(result.jobs).toHaveLength(48);
    expect(result.jobs[0].jobId).toBe(999);
    expect(result.jobs.some((j) => j.jobId === 48)).toBe(false);
    expect(finalizeJobSet([makeJob(1)], { metric: 'up', baseline: makeJob(1) }).jobs).toHaveLength(1);
  });
});

describe('loadCompareTimeRange', () => {
  it('uses URL from/to and falls back to the last 7 days', () => {
    expect(loadCompareTimeRange(new URLSearchParams('from=now-30d&to=now')).raw).toEqual({ from: 'now-30d', to: 'now' });
    expect(loadCompareTimeRange(new URLSearchParams()).raw).toEqual({ from: 'now-7d', to: 'now' });
    expect(loadCompareTimeRange(new URLSearchParams('from=garbage&to=now')).raw).toEqual({ from: 'now-7d', to: 'now' });
  });
});
```

`src/storage/userPreferences.test.ts` の import に `loadCompareViewPreferences, saveCompareViewPreferences` を追加し、`describe('user preferences storage', ...)` 内に次を追加:

```ts
  it('persists compare view options without job-specific state', () => {
    saveCompareViewPreferences({
      metric: 'DCGM_FI_DEV_GPU_UTIL',
      layout: 'overlay',
      xAxis: 'progress',
      reduce: 'mean',
      yScale: 'independent',
      sort: 'start',
      columns: '6',
      elapsedLimitHours: 0,
      baselineJobId: '123',
      jobSetMode: 'pick',
      pickedJobIds: ['1', '2'],
      selectedJobIds: ['1'],
    });

    expect(loadCompareViewPreferences()).toEqual({
      metric: 'DCGM_FI_DEV_GPU_UTIL',
      layout: 'overlay',
      xAxis: 'progress',
      reduce: 'mean',
      yScale: 'independent',
      sort: 'start',
      columns: '6',
    });
  });

  it('returns no compare view preferences when nothing is stored', () => {
    expect(loadCompareViewPreferences()).toEqual({});
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest --testPathPatterns="JobCompare/jobSet.test|storage/userPreferences.test"`
Expected: FAIL（`Cannot find module './jobSet'` と `loadCompareViewPreferences is not a function`）

- [ ] **Step 3: Write minimal implementation**

`src/pages/JobCompare/jobSet.ts`:

```ts
import { dateMath, TimeRange } from '@grafana/data';
import { getJob, listJobs } from '../../api/slurmApi';
import { JobRecord } from '../../api/types';
import { buildListJobsParams, SearchFilters, timelineRangeFromURLParams } from '../JobSearch/model';
import { makeRelativeTimeRange } from '../JobSearch/timelineRange';
import { isGpuMetric } from './metricCatalog';
import { COMPARE_JOB_LIMIT, DEFAULT_COMPARE_RAW_FROM, DEFAULT_COMPARE_RAW_TO } from './model';

const PICK_CONCURRENCY = 6;

export function loadCompareTimeRange(params: URLSearchParams): TimeRange {
  const range = timelineRangeFromURLParams(params);
  if (range && dateMath.isValid(range.from) && dateMath.isValid(range.to)) {
    return makeRelativeTimeRange(range.from, range.to);
  }
  return makeRelativeTimeRange(DEFAULT_COMPARE_RAW_FROM, DEFAULT_COMPARE_RAW_TO);
}

export async function loadFilterJobSet(
  filters: SearchFilters,
  range: { from: number; to: number }
): Promise<{ jobs: JobRecord[]; total: number }> {
  const response = await listJobs({ ...buildListJobsParams(filters, { timeRange: range }), limit: COMPARE_JOB_LIMIT });
  return { jobs: response.jobs.slice(0, COMPARE_JOB_LIMIT), total: response.total };
}

export async function loadPickedJobs(clusterId: string, ids: string[]): Promise<{ jobs: JobRecord[]; missingIds: string[] }> {
  const targets = ids.slice(0, COMPARE_JOB_LIMIT);
  const jobs: JobRecord[] = [];
  const missingIds: string[] = [];
  for (let i = 0; i < targets.length; i += PICK_CONCURRENCY) {
    const chunk = targets.slice(i, i + PICK_CONCURRENCY);
    const settled = await Promise.allSettled(chunk.map((id) => getJob(clusterId, id)));
    settled.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') {
        jobs.push(outcome.value);
      } else {
        missingIds.push(chunk[index]);
      }
    });
  }
  return { jobs, missingIds };
}

export function finalizeJobSet(
  jobs: JobRecord[],
  { metric, baseline }: { metric: string; baseline: JobRecord | null }
): { jobs: JobRecord[]; hiddenNonGpu: number } {
  let list = jobs;
  if (baseline && !list.some((job) => String(job.jobId) === String(baseline.jobId))) {
    // Jobs arrive newest first, so the oldest job makes room for the baseline.
    list = [baseline, ...list].slice(0, COMPARE_JOB_LIMIT);
  }
  if (!isGpuMetric(metric)) {
    return { jobs: list, hiddenNonGpu: 0 };
  }
  const visible = list.filter((job) => job.gpusTotal > 0);
  return { jobs: visible, hiddenNonGpu: list.length - visible.length };
}
```

`src/storage/userPreferences.ts` に追加（import は先頭、定数は既存の定数群の後、関数はファイル末尾）:

```ts
import { CompareViewState, viewStateFromURLParams, viewStateToURLParams } from '../pages/JobCompare/model';

const COMPARE_VIEW_KEY = 'yuuki-slurm-app.compare-view';

export function loadCompareViewPreferences(): Partial<CompareViewState> {
  const raw = window.localStorage.getItem(COMPARE_VIEW_KEY);
  return raw ? viewStateFromURLParams(new URLSearchParams(raw)) : {};
}

export function saveCompareViewPreferences(view: CompareViewState) {
  // Job-specific state belongs to the URL only; the stored state is the user's preferred presentation.
  const persisted = viewStateToURLParams({
    ...view,
    baselineJobId: '',
    jobSetMode: 'filter',
    pickedJobIds: [],
    selectedJobIds: [],
  });
  window.localStorage.setItem(COMPARE_VIEW_KEY, persisted.toString());
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest --testPathPatterns="JobCompare/jobSet.test|storage/userPreferences.test" && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pages/JobCompare/jobSet.ts src/pages/JobCompare/jobSet.test.ts src/storage/userPreferences.ts src/storage/userPreferences.test.ts
git commit -m "feat: load job sets and persist view options for metric compare"
```

---

### Task 7: ビューモデルの導出（ステータス・軸・スコア・並べ替え）

**Files:**
- Create: `src/pages/JobCompare/compareView.ts`
- Test: `src/pages/JobCompare/compareView.test.ts`

**Interfaces:**
- Consumes: `jobKey`、`DeviationResult`, `DeviationScorer`, `medianDeviationScorer`（Task 3）、`CompareViewState`, `CompareSort`, `OVERLAY_LINE_LIMIT`, `PROFILE_BINS`（Task 1）、`binSeries`, `jobEndTime`, `JobSeries`, `projectTimes`, `reduceLine`, `summarize`（Task 2）
- Produces:
  - 型 `CellStatus = 'loading' | 'ready' | 'no-data' | 'error'`
  - 型 `ChartLineData = { x: number[]; y: number[]; band?: { min: number[]; max: number[] } }`
  - 型 `CompareCellModel = { key: string; job: JobRecord; status: CellStatus; line: ChartLineData | null; stats: { mean: number | undefined; p95: number | undefined; durationSec: number }; deviation: DeviationResult | undefined; isBaseline: boolean; isRunning: boolean; endedAbnormally: boolean; excludedFromScoring: boolean }`
  - 型 `CompareViewModel = { cells: CompareCellModel[]; xDomain: [number, number]; yDomain: [number, number] | null; baselineLine: ChartLineData | null }`
  - `buildCompareView(input: { jobs: JobRecord[]; series: Map<string, JobSeries>; failedJobKeys: Set<string>; loading: boolean; view: CompareViewState; now: number; scorer?: DeviationScorer }): CompareViewModel`
  - `computeYDomain(lines: Array<ChartLineData | null>): [number, number] | null`
  - `selectOverlayCells(cells: CompareCellModel[], selectedJobIds: string[]): { cells: CompareCellModel[]; truncated: boolean }`

- [ ] **Step 1: Write the failing test**

`src/pages/JobCompare/compareView.test.ts`:

```ts
import { JobRecord } from '../../api/types';
import { buildCompareView, computeYDomain, selectOverlayCells } from './compareView';
import { DEFAULT_VIEW_STATE } from './model';
import { JobSeries } from './seriesTransform';

const NOW = 100_000;

function makeJob(jobId: number, startTime = 10_000, endTime = 17_200, state = 'COMPLETED'): JobRecord {
  return {
    clusterId: 'a100',
    jobId,
    name: `train-${jobId}`,
    user: 'alice',
    account: 'ml',
    partition: 'gpu',
    state,
    nodes: ['n1'],
    nodeList: 'n1',
    nodeCount: 1,
    gpusTotal: 8,
    submitTime: startTime,
    startTime,
    endTime,
    exitCode: 0,
    workDir: '/tmp',
    tres: '',
    templateId: 'overview',
  };
}

function flatSeries(job: JobRecord, value: number): JobSeries {
  const end = job.endTime > 0 ? job.endTime : NOW;
  const times: number[] = [];
  for (let t = job.startTime; t <= end; t += 600) {
    times.push(t);
  }
  return { times, mean: times.map(() => value), min: times.map(() => value - 1), max: times.map(() => value + 1) };
}

function seriesFor(entries: Array<[JobRecord, number]>): Map<string, JobSeries> {
  return new Map(entries.map(([job, value]) => [`a100-${job.jobId}`, flatSeries(job, value)]));
}

describe('buildCompareView', () => {
  it('derives cell status from series, failures, and loading', () => {
    const jobs = [makeJob(1), makeJob(2), makeJob(3)];
    const input = {
      jobs,
      series: seriesFor([[jobs[0], 50]]),
      failedJobKeys: new Set(['a100-2']),
      view: DEFAULT_VIEW_STATE,
      now: NOW,
    };
    const loading = buildCompareView({ ...input, loading: true });
    const byId = (model: typeof loading, id: number) => model.cells.find((c) => c.job.jobId === id)!;
    expect(byId(loading, 1).status).toBe('ready');
    expect(byId(loading, 2).status).toBe('error');
    expect(byId(loading, 3).status).toBe('loading');
    expect(byId(buildCompareView({ ...input, loading: false }), 3).status).toBe('no-data');
  });

  it('sorts the deviating job first and flags it', () => {
    const jobs = [1, 2, 3, 4, 5].map((id) => makeJob(id));
    const values = [60, 61, 59, 60, 20];
    const model = buildCompareView({
      jobs,
      series: seriesFor(jobs.map((job, i) => [job, values[i]])),
      failedJobKeys: new Set(),
      loading: false,
      view: DEFAULT_VIEW_STATE,
      now: NOW,
    });
    expect(model.cells[0].job.jobId).toBe(5);
    expect(model.cells[0].deviation?.flagged).toBe(true);
    expect(model.cells[0].deviation?.signedMean).toBeCloseTo(-40);
    expect(model.cells.slice(1).every((c) => !c.deviation?.flagged)).toBe(true);
  });

  it('excludes running jobs from scoring on the progress axis', () => {
    const jobs = [1, 2, 3, 4].map((id) => makeJob(id));
    const running = makeJob(5, 10_000, 0, 'RUNNING');
    const model = buildCompareView({
      jobs: [...jobs, running],
      series: seriesFor([...jobs.map((job): [JobRecord, number] => [job, 60]), [running, 0]]),
      failedJobKeys: new Set(),
      loading: false,
      view: { ...DEFAULT_VIEW_STATE, xAxis: 'progress' },
      now: NOW,
    });
    const runningCell = model.cells.find((c) => c.job.jobId === 5)!;
    expect(runningCell.excludedFromScoring).toBe(true);
    expect(runningCell.deviation).toBeUndefined();
    expect(model.cells[model.cells.length - 1].job.jobId).toBe(5);
    expect(model.xDomain).toEqual([0, 100]);
  });

  it('limits the elapsed axis and the plotted points', () => {
    const job = makeJob(1);
    const model = buildCompareView({
      jobs: [job],
      series: seriesFor([[job, 10]]),
      failedJobKeys: new Set(),
      loading: false,
      view: { ...DEFAULT_VIEW_STATE, elapsedLimitHours: 1 },
      now: NOW,
    });
    expect(model.xDomain).toEqual([0, 3600]);
    expect(Math.max(...model.cells[0].line!.x)).toBe(3600);
    expect(model.cells[0].line!.band?.min).toHaveLength(model.cells[0].line!.x.length);
    expect(model.cells[0].stats.durationSec).toBe(7200);
  });

  it('uses the longest job for the elapsed domain and job windows for the absolute domain', () => {
    const jobs = [makeJob(1, 10_000, 13_600), makeJob(2, 20_000, 27_200)];
    const base = { jobs, series: new Map(), failedJobKeys: new Set<string>(), loading: false, now: NOW };
    expect(buildCompareView({ ...base, view: DEFAULT_VIEW_STATE }).xDomain).toEqual([0, 7200]);
    expect(buildCompareView({ ...base, view: { ...DEFAULT_VIEW_STATE, xAxis: 'absolute' } }).xDomain).toEqual([10_000, 27_200]);
  });

  it('shares the y domain only when requested and exposes the baseline line', () => {
    const jobs = [makeJob(1), makeJob(2)];
    const input = {
      jobs,
      series: seriesFor([[jobs[0], 10], [jobs[1], 30]]),
      failedJobKeys: new Set<string>(),
      loading: false,
      now: NOW,
    };
    const shared = buildCompareView({ ...input, view: { ...DEFAULT_VIEW_STATE, baselineJobId: '2' } });
    expect(shared.yDomain).toEqual([0, 31]);
    expect(shared.baselineLine?.y[0]).toBe(30);
    expect(shared.cells.find((c) => c.job.jobId === 2)?.isBaseline).toBe(true);
    expect(buildCompareView({ ...input, view: { ...DEFAULT_VIEW_STATE, yScale: 'independent' } }).yDomain).toBeNull();
  });

  it('sorts by mean, start, duration, and job id', () => {
    const jobs = [makeJob(2, 10_000, 20_000), makeJob(1, 30_000, 31_000), makeJob(3, 20_000, 21_000)];
    const input = {
      jobs,
      series: seriesFor([[jobs[0], 5], [jobs[1], 50], [jobs[2], 20]]),
      failedJobKeys: new Set<string>(),
      loading: false,
      now: NOW,
    };
    const ids = (sort: typeof DEFAULT_VIEW_STATE.sort) =>
      buildCompareView({ ...input, view: { ...DEFAULT_VIEW_STATE, sort } }).cells.map((c) => c.job.jobId);
    expect(ids('mean-desc')).toEqual([1, 3, 2]);
    expect(ids('mean-asc')).toEqual([2, 3, 1]);
    expect(ids('start')).toEqual([1, 3, 2]);
    expect(ids('duration')).toEqual([2, 1, 3]);
    expect(ids('job-id')).toEqual([1, 2, 3]);
  });
});

describe('computeYDomain', () => {
  it('pads flat lines and keeps negative minimums', () => {
    expect(computeYDomain([{ x: [0], y: [5] }])).toEqual([0, 5]);
    expect(computeYDomain([{ x: [0], y: [0] }])).toEqual([0, 1]);
    expect(computeYDomain([{ x: [0, 1], y: [-2, 3] }])).toEqual([-2, 3]);
    expect(computeYDomain([null])).toBeNull();
  });
});

describe('selectOverlayCells', () => {
  const jobs = Array.from({ length: 12 }, (_, i) => makeJob(i + 1));
  const model = buildCompareView({
    jobs,
    series: seriesFor(jobs.map((job): [JobRecord, number] => [job, job.jobId])),
    failedJobKeys: new Set(),
    loading: false,
    view: { ...DEFAULT_VIEW_STATE, sort: 'job-id' },
    now: NOW,
  });

  it('uses the selected jobs when present', () => {
    const result = selectOverlayCells(model.cells, ['3', '5']);
    expect(result.cells.map((c) => c.job.jobId)).toEqual([3, 5]);
    expect(result.truncated).toBe(false);
  });

  it('falls back to the first 10 cells and reports truncation', () => {
    const result = selectOverlayCells(model.cells, []);
    expect(result.cells).toHaveLength(10);
    expect(result.truncated).toBe(true);
  });
});
```

`duration` の期待値: job2=10000s、job1=1000s、job3=1000s。同値は開始の新しい順（job1 の開始 30000 > job3 の 20000）なので `[2, 1, 3]`。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --testPathPatterns=JobCompare/compareView.test`
Expected: FAIL（`Cannot find module './compareView'`）

- [ ] **Step 3: Write minimal implementation**

`src/pages/JobCompare/compareView.ts`:

```ts
import { JobRecord } from '../../api/types';
import { jobKey } from '../JobSearch/model';
import { DeviationResult, DeviationScorer, medianDeviationScorer } from './deviation';
import { CompareSort, CompareViewState, OVERLAY_LINE_LIMIT, PROFILE_BINS } from './model';
import { binSeries, jobEndTime, JobSeries, projectTimes, reduceLine, summarize } from './seriesTransform';

export type CellStatus = 'loading' | 'ready' | 'no-data' | 'error';

export interface ChartLineData {
  x: number[];
  y: number[];
  band?: { min: number[]; max: number[] };
}

export interface CompareCellModel {
  key: string;
  job: JobRecord;
  status: CellStatus;
  line: ChartLineData | null;
  stats: { mean: number | undefined; p95: number | undefined; durationSec: number };
  deviation: DeviationResult | undefined;
  isBaseline: boolean;
  isRunning: boolean;
  endedAbnormally: boolean;
  excludedFromScoring: boolean;
}

export interface CompareViewModel {
  cells: CompareCellModel[];
  xDomain: [number, number];
  yDomain: [number, number] | null;
  baselineLine: ChartLineData | null;
}

export interface BuildCompareViewInput {
  jobs: JobRecord[];
  series: Map<string, JobSeries>;
  failedJobKeys: Set<string>;
  loading: boolean;
  view: CompareViewState;
  now: number;
  scorer?: DeviationScorer;
}

const ABNORMAL_END_STATES = new Set(['FAILED', 'NODE_FAIL', 'TIMEOUT', 'OUT_OF_MEMORY']);

function keepWhere<T>(values: T[], keep: boolean[]): T[] {
  return values.filter((_, i) => keep[i]);
}

function buildLine(series: JobSeries, job: JobRecord, view: CompareViewState, now: number): ChartLineData {
  let x = projectTimes(series.times, job, view.xAxis, now);
  let y = reduceLine(series, view.reduce);
  let min = series.min;
  let max = series.max;
  if (view.xAxis === 'elapsed' && view.elapsedLimitHours > 0) {
    const limit = view.elapsedLimitHours * 3600;
    const keep = x.map((value) => value <= limit);
    x = keepWhere(x, keep);
    y = keepWhere(y, keep);
    min = keepWhere(min, keep);
    max = keepWhere(max, keep);
  }
  return view.reduce === 'band' ? { x, y, band: { min, max } } : { x, y };
}

export function computeYDomain(lines: Array<ChartLineData | null>): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const line of lines) {
    if (!line) {
      continue;
    }
    for (const values of [line.y, line.band?.min ?? [], line.band?.max ?? []]) {
      for (const v of values) {
        if (Number.isFinite(v)) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
    }
  }
  if (!Number.isFinite(lo)) {
    return null;
  }
  if (lo >= 0) {
    lo = 0;
  }
  if (hi === lo) {
    hi = lo + 1;
  }
  return [lo, hi];
}

function computeXDomain(jobs: JobRecord[], view: CompareViewState, now: number): [number, number] {
  const started = jobs.filter((job) => job.startTime > 0);
  switch (view.xAxis) {
    case 'progress':
      return [0, 100];
    case 'absolute':
      if (started.length === 0) {
        return [now - 3600, now];
      }
      return [Math.min(...started.map((j) => j.startTime)), Math.max(...started.map((j) => jobEndTime(j, now)))];
    default: {
      if (view.elapsedLimitHours > 0) {
        return [0, view.elapsedLimitHours * 3600];
      }
      const longest = Math.max(0, ...started.map((j) => jobEndTime(j, now) - j.startTime));
      return [0, Math.max(longest, 1)];
    }
  }
}

function scoreCells(cells: CompareCellModel[], input: BuildCompareViewInput): Map<string, DeviationResult> {
  const { view, now, series } = input;
  // The absolute axis has no shared shape, so it is scored on elapsed time.
  const axis = view.xAxis === 'progress' ? 'progress' : 'elapsed';
  const eligible = cells.filter((c) => c.status === 'ready' && !c.excludedFromScoring);
  const hi =
    axis === 'progress'
      ? 100
      : view.elapsedLimitHours > 0
        ? view.elapsedLimitHours * 3600
        : Math.max(1, ...eligible.map((c) => c.stats.durationSec));
  const profiles = new Map<string, number[]>();
  for (const cell of eligible) {
    const s = series.get(cell.key)!;
    const x = projectTimes(s.times, cell.job, axis, now);
    profiles.set(cell.key, binSeries(x, reduceLine(s, view.reduce), 0, hi, PROFILE_BINS));
  }
  return (input.scorer ?? medianDeviationScorer)(profiles);
}

function compareOptional(a: number | undefined, b: number | undefined, direction: 1 | -1): number {
  if (a === undefined && b === undefined) {
    return 0;
  }
  if (a === undefined) {
    return 1;
  }
  if (b === undefined) {
    return -1;
  }
  return (a - b) * direction;
}

function byStartDesc(a: CompareCellModel, b: CompareCellModel): number {
  return b.job.startTime - a.job.startTime;
}

function sortCells(cells: CompareCellModel[], sort: CompareSort): CompareCellModel[] {
  const sorted = [...cells];
  switch (sort) {
    case 'deviation':
      return sorted.sort((a, b) => compareOptional(a.deviation?.score, b.deviation?.score, -1) || byStartDesc(a, b));
    case 'mean-desc':
      return sorted.sort((a, b) => compareOptional(a.stats.mean, b.stats.mean, -1) || byStartDesc(a, b));
    case 'mean-asc':
      return sorted.sort((a, b) => compareOptional(a.stats.mean, b.stats.mean, 1) || byStartDesc(a, b));
    case 'duration':
      return sorted.sort((a, b) => b.stats.durationSec - a.stats.durationSec || byStartDesc(a, b));
    case 'job-id':
      return sorted.sort((a, b) => a.job.jobId - b.job.jobId);
    default:
      return sorted.sort(byStartDesc);
  }
}

export function buildCompareView(input: BuildCompareViewInput): CompareViewModel {
  const { jobs, series, failedJobKeys, loading, view, now } = input;
  const cells: CompareCellModel[] = jobs.map((job) => {
    const key = jobKey(job.clusterId, job.jobId);
    const s = series.get(key);
    const status: CellStatus = s ? 'ready' : failedJobKeys.has(key) ? 'error' : loading ? 'loading' : 'no-data';
    const isRunning = job.endTime === 0;
    return {
      key,
      job,
      status,
      line: s ? buildLine(s, job, view, now) : null,
      stats: {
        ...summarize(s ? reduceLine(s, view.reduce) : []),
        durationSec: job.startTime > 0 ? Math.max(jobEndTime(job, now) - job.startTime, 0) : 0,
      },
      deviation: undefined,
      isBaseline: view.baselineJobId !== '' && String(job.jobId) === view.baselineJobId,
      isRunning,
      endedAbnormally: ABNORMAL_END_STATES.has(job.state),
      excludedFromScoring: view.xAxis === 'progress' && isRunning,
    };
  });

  const deviations = scoreCells(cells, input);
  for (const cell of cells) {
    cell.deviation = deviations.get(cell.key);
  }

  return {
    cells: sortCells(cells, view.sort),
    xDomain: computeXDomain(jobs, view, now),
    yDomain: view.yScale === 'shared' ? computeYDomain(cells.map((c) => c.line)) : null,
    baselineLine: cells.find((c) => c.isBaseline && c.line)?.line ?? null,
  };
}

export function selectOverlayCells(
  cells: CompareCellModel[],
  selectedJobIds: string[]
): { cells: CompareCellModel[]; truncated: boolean } {
  const ready = cells.filter((c) => c.status === 'ready');
  const pool = selectedJobIds.length > 0 ? ready.filter((c) => selectedJobIds.includes(String(c.job.jobId))) : ready;
  return { cells: pool.slice(0, OVERLAY_LINE_LIMIT), truncated: pool.length > OVERLAY_LINE_LIMIT };
}
```

確認: shared y domain のテストは band 込みで max=31（30+1）、min=9 ≥ 0 なので下限 0 → `[0, 31]`。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --testPathPatterns=JobCompare/compareView.test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pages/JobCompare/compareView.ts src/pages/JobCompare/compareView.test.ts
git commit -m "feat: derive metric compare cells, axes, deviation, and sort order"
```

---

### Task 8: SVG チャート部品

**Files:**
- Create: `src/pages/JobCompare/chartScale.ts`
- Create: `src/pages/JobCompare/CompareChart.tsx`
- Test: `src/pages/JobCompare/chartScale.test.ts`
- Test: `src/pages/JobCompare/CompareChart.test.tsx`

**Interfaces:**
- Consumes: `formatDuration(seconds: number): string`（`JobSearch/jobTime.ts`）、`CompareXAxis`（Task 1）
- Produces:
  - `chartScale.ts`: `CHART_VIEWBOX_WIDTH = 1000`, `scaleValue(value: number, domain: [number, number], range: [number, number]): number`, `buildLinePath(x: number[], y: number[], xDomain: [number, number], yDomain: [number, number], width: number, height: number): string`, `buildBandPath(x: number[], min: number[], max: number[], xDomain, yDomain, width: number, height: number): string`, `formatXValue(x: number, axis: CompareXAxis): string`, `formatValue(value: number | undefined): string`
  - `CompareChart.tsx`: 型 `ChartSeries = { id: string; x: number[]; y: number[]; color: string; width?: number; dashed?: boolean; opacity?: number; band?: { min: number[]; max: number[] } }`, 型 `ChartMarker = { x: number; kind: 'running' | 'abnormal-end' }`, コンポーネント `CompareChart(props: { series: ChartSeries[]; xDomain: [number, number]; yDomain: [number, number]; height: number; ariaLabel: string; cursorX?: number | null; cursorColor?: string; markers?: ChartMarker[]; markerColor?: string; onCursorChange?: (x: number | null) => void; onClick?: (event: React.MouseEvent<SVGSVGElement>) => void })`。SVG 内の要素に `data-testid`: `line-<id>`, `band-<id>`, `marker-running`, `marker-abnormal-end`, `cursor`。

- [ ] **Step 1: Write the failing tests**

`src/pages/JobCompare/chartScale.test.ts`:

```ts
import { buildBandPath, buildLinePath, formatValue, formatXValue, scaleValue } from './chartScale';

describe('chartScale', () => {
  it('scales linearly and handles empty domains', () => {
    expect(scaleValue(5, [0, 10], [0, 100])).toBe(50);
    expect(scaleValue(5, [0, 10], [100, 0])).toBe(50);
    expect(scaleValue(5, [5, 5], [0, 100])).toBe(0);
  });

  it('breaks the line at missing values', () => {
    expect(buildLinePath([0, 1, 2, 3], [0, 1, NaN, 1], [0, 3], [0, 1], 300, 100)).toBe('M0 100 L100 0 M300 0');
  });

  it('builds closed band polygons per contiguous segment', () => {
    expect(buildBandPath([0, 1], [0, 0], [1, 1], [0, 1], [0, 1], 100, 100)).toBe('M0 0 L100 0 L100 100 L0 100 Z');
    expect(buildBandPath([0, 1, 2], [0, NaN, 0], [1, NaN, 1], [0, 2], [0, 1], 100, 100)).toBe('');
  });

  it('formats x values per axis', () => {
    expect(formatXValue(42.4, 'progress')).toBe('42%');
    expect(formatXValue(12660, 'elapsed')).toBe('3h 31m');
    expect(formatXValue(0, 'absolute')).toBe('1970-01-01 00:00');
  });

  it('formats values compactly', () => {
    expect(formatValue(undefined)).toBe('-');
    expect(formatValue(NaN)).toBe('-');
    expect(formatValue(0.61234)).toBe('0.612');
    expect(formatValue(61.23)).toBe('61.2');
    expect(formatValue(612.3)).toBe('612');
    expect(formatValue(1234)).toBe('1.2k');
    expect(formatValue(2_500_000)).toBe('2.5M');
    expect(formatValue(3_000_000_000)).toBe('3.0G');
  });
});
```

`src/pages/JobCompare/CompareChart.test.tsx`:

```tsx
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { CompareChart } from './CompareChart';

describe('CompareChart', () => {
  const series = [
    { id: 'job', x: [0, 50, 100], y: [1, 2, 3], color: 'blue', band: { min: [0, 1, 2], max: [2, 3, 4] } },
    { id: 'baseline', x: [0, 100], y: [2, 2], color: 'gray', dashed: true },
  ];

  it('renders lines, bands, markers, and the cursor', () => {
    render(
      <CompareChart
        series={series}
        xDomain={[0, 100]}
        yDomain={[0, 4]}
        height={80}
        ariaLabel="Series for job 1"
        cursorX={50}
        markers={[{ x: 100, kind: 'running' }, { x: 100, kind: 'abnormal-end' }]}
      />
    );
    expect(screen.getByRole('img', { name: 'Series for job 1' })).toBeInTheDocument();
    expect(screen.getByTestId('line-job')).toBeInTheDocument();
    expect(screen.getByTestId('band-job')).toBeInTheDocument();
    expect(screen.getByTestId('line-baseline')).toHaveAttribute('stroke-dasharray', '4 3');
    expect(screen.queryByTestId('band-baseline')).toBeNull();
    expect(screen.getByTestId('marker-running')).toBeInTheDocument();
    expect(screen.getByTestId('marker-abnormal-end')).toBeInTheDocument();
    expect(screen.getByTestId('cursor')).toHaveAttribute('x1', '500');
  });

  it('reports the hovered x value and clears it on leave', () => {
    const onCursorChange = jest.fn();
    render(
      <CompareChart series={series} xDomain={[0, 100]} yDomain={[0, 4]} height={80} ariaLabel="chart" onCursorChange={onCursorChange} />
    );
    const svg = screen.getByRole('img', { name: 'chart' });
    jest.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 200, top: 0, height: 80 } as DOMRect);
    fireEvent.mouseMove(svg, { clientX: 50 });
    expect(onCursorChange).toHaveBeenLastCalledWith(25);
    fireEvent.mouseLeave(svg);
    expect(onCursorChange).toHaveBeenLastCalledWith(null);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest --testPathPatterns="JobCompare/(chartScale|CompareChart).test"`
Expected: FAIL（モジュールが存在しない）

- [ ] **Step 3: Write minimal implementation**

`src/pages/JobCompare/chartScale.ts`:

```ts
import { formatDuration } from '../JobSearch/jobTime';
import { CompareXAxis } from './model';

export const CHART_VIEWBOX_WIDTH = 1000;

export function scaleValue(value: number, domain: [number, number], range: [number, number]): number {
  const span = domain[1] - domain[0];
  if (span === 0) {
    return range[0];
  }
  return range[0] + ((value - domain[0]) / span) * (range[1] - range[0]);
}

function fmt(n: number): string {
  return String(Number(n.toFixed(2)));
}

function point(
  x: number,
  y: number,
  xDomain: [number, number],
  yDomain: [number, number],
  width: number,
  height: number
): string {
  return `${fmt(scaleValue(x, xDomain, [0, width]))} ${fmt(scaleValue(y, yDomain, [height, 0]))}`;
}

export function buildLinePath(
  x: number[],
  y: number[],
  xDomain: [number, number],
  yDomain: [number, number],
  width: number,
  height: number
): string {
  const parts: string[] = [];
  let penDown = false;
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(y[i])) {
      penDown = false;
      continue;
    }
    parts.push(`${penDown ? 'L' : 'M'}${point(x[i], y[i], xDomain, yDomain, width, height)}`);
    penDown = true;
  }
  return parts.join(' ');
}

export function buildBandPath(
  x: number[],
  min: number[],
  max: number[],
  xDomain: [number, number],
  yDomain: [number, number],
  width: number,
  height: number
): string {
  const segments: number[][] = [];
  let current: number[] = [];
  for (let i = 0; i < x.length; i++) {
    if (Number.isFinite(min[i]) && Number.isFinite(max[i])) {
      current.push(i);
    } else if (current.length > 0) {
      segments.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    segments.push(current);
  }
  return segments
    .filter((segment) => segment.length > 1)
    .map((segment) => {
      const top = segment.map((i) => point(x[i], max[i], xDomain, yDomain, width, height));
      const bottom = [...segment].reverse().map((i) => point(x[i], min[i], xDomain, yDomain, width, height));
      return `M${top.join(' L')} L${bottom.join(' L')} Z`;
    })
    .join(' ');
}

export function formatXValue(x: number, axis: CompareXAxis): string {
  switch (axis) {
    case 'progress':
      return `${Math.round(x)}%`;
    case 'absolute':
      return new Date(x * 1000).toISOString().slice(0, 16).replace('T', ' ');
    default:
      return formatDuration(Math.round(x));
  }
}

export function formatValue(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return '-';
  }
  const abs = Math.abs(value);
  if (abs >= 1e9) {
    return `${(value / 1e9).toFixed(1)}G`;
  }
  if (abs >= 1e6) {
    return `${(value / 1e6).toFixed(1)}M`;
  }
  if (abs >= 1e3) {
    return `${(value / 1e3).toFixed(1)}k`;
  }
  if (abs >= 100) {
    return value.toFixed(0);
  }
  if (abs >= 1) {
    return value.toFixed(1);
  }
  return value.toFixed(3);
}
```

`src/pages/JobCompare/CompareChart.tsx`:

```tsx
import React, { useCallback } from 'react';
import { buildBandPath, buildLinePath, CHART_VIEWBOX_WIDTH, scaleValue } from './chartScale';

export interface ChartSeries {
  id: string;
  x: number[];
  y: number[];
  color: string;
  width?: number;
  dashed?: boolean;
  opacity?: number;
  band?: { min: number[]; max: number[] };
}

export interface ChartMarker {
  x: number;
  kind: 'running' | 'abnormal-end';
}

interface Props {
  series: ChartSeries[];
  xDomain: [number, number];
  yDomain: [number, number];
  height: number;
  ariaLabel: string;
  cursorX?: number | null;
  cursorColor?: string;
  markers?: ChartMarker[];
  markerColor?: string;
  onCursorChange?: (x: number | null) => void;
  onClick?: (event: React.MouseEvent<SVGSVGElement>) => void;
}

export function CompareChart({
  series,
  xDomain,
  yDomain,
  height,
  ariaLabel,
  cursorX = null,
  cursorColor = 'currentColor',
  markers = [],
  markerColor = 'currentColor',
  onCursorChange,
  onClick,
}: Props) {
  const width = CHART_VIEWBOX_WIDTH;

  const handleMove = useCallback(
    (event: React.MouseEvent<SVGSVGElement>) => {
      if (!onCursorChange) {
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      if (rect.width <= 0) {
        return;
      }
      const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      onCursorChange(xDomain[0] + ratio * (xDomain[1] - xDomain[0]));
    },
    [onCursorChange, xDomain]
  );

  const cursorPx = cursorX === null ? null : scaleValue(cursorX, xDomain, [0, width]);

  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      width="100%"
      height={height}
      style={{ display: 'block', cursor: onClick ? 'pointer' : undefined }}
      onMouseMove={handleMove}
      onMouseLeave={() => onCursorChange?.(null)}
      onClick={onClick}
    >
      {series.map((s) =>
        s.band ? (
          <path
            key={`${s.id}-band`}
            data-testid={`band-${s.id}`}
            d={buildBandPath(s.x, s.band.min, s.band.max, xDomain, yDomain, width, height)}
            fill={s.color}
            fillOpacity={0.15 * (s.opacity ?? 1)}
            stroke="none"
          />
        ) : null
      )}
      {series.map((s) => (
        <path
          key={s.id}
          data-testid={`line-${s.id}`}
          d={buildLinePath(s.x, s.y, xDomain, yDomain, width, height)}
          fill="none"
          stroke={s.color}
          strokeWidth={s.width ?? 1.5}
          strokeDasharray={s.dashed ? '4 3' : undefined}
          strokeOpacity={s.opacity ?? 1}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {markers.map((marker, i) => {
        const px = scaleValue(marker.x, xDomain, [0, width]);
        return marker.kind === 'running' ? (
          <line
            key={i}
            data-testid="marker-running"
            x1={px}
            x2={px}
            y1={0}
            y2={height}
            stroke={markerColor}
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
          />
        ) : (
          <path
            key={i}
            data-testid="marker-abnormal-end"
            d={`M${px - 8} 2 L${px} 12 M${px} 2 L${px - 8} 12`}
            stroke={markerColor}
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
      {cursorPx !== null && (
        <line
          data-testid="cursor"
          x1={cursorPx}
          x2={cursorPx}
          y1={0}
          y2={height}
          stroke={cursorColor}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest --testPathPatterns="JobCompare/(chartScale|CompareChart).test" && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pages/JobCompare/chartScale.ts src/pages/JobCompare/chartScale.test.ts src/pages/JobCompare/CompareChart.tsx src/pages/JobCompare/CompareChart.test.tsx
git commit -m "feat: add SVG time series chart for metric compare"
```

---

### Task 9: ジョブセルとグリッド（同期カーソル）

**Files:**
- Create: `src/pages/JobCompare/CompareCell.tsx`
- Create: `src/pages/JobCompare/CompareGrid.tsx`
- Test: `src/pages/JobCompare/CompareGrid.test.tsx`

**Interfaces:**
- Consumes: `CompareChart`, `ChartSeries`, `ChartMarker`（Task 8）、`formatValue`, `formatXValue`（Task 8）、`CompareCellModel`, `CompareViewModel`, `ChartLineData`, `computeYDomain`（Task 7）、`CompareViewState`, `CompareXAxis`（Task 1）、`valueAt`（Task 2）、`getJobStateTimelineColor`、`formatDuration`
- Produces:
  - `CompareCell(props: { cell: CompareCellModel; xAxis: CompareXAxis; xDomain: [number, number]; yDomain: [number, number] | null; baselineLine: ChartLineData | null; height: number; showDeviation: boolean; selected: boolean; cursorX: number | null; onCursorChange: (x: number | null) => void; onOpen: (cell: CompareCellModel) => void; onToggleSelect: (cell: CompareCellModel) => void; onSetBaseline: (cell: CompareCellModel) => void; onOpenDashboard: (cell: CompareCellModel) => void })`
  - 型 `CompareCellActions = Pick<CompareCellProps, 'onOpen' | 'onToggleSelect' | 'onSetBaseline' | 'onOpenDashboard'>`
  - `CompareGrid(props: { model: CompareViewModel; state: CompareViewState } & CompareCellActions)`
  - セルのルート要素は `role="group"` と `aria-label="Job <jobId>"`、乖離ハイライト時は `data-flagged="true"`。

- [ ] **Step 1: Write the failing test**

`src/pages/JobCompare/CompareGrid.test.tsx`:

```tsx
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { JobRecord } from '../../api/types';
import { CompareGrid } from './CompareGrid';
import { buildCompareView } from './compareView';
import { DEFAULT_VIEW_STATE } from './model';
import { JobSeries } from './seriesTransform';

const NOW = 100_000;

function makeJob(jobId: number, state = 'COMPLETED', endTime = 17_200): JobRecord {
  return {
    clusterId: 'a100',
    jobId,
    name: `train-${jobId}`,
    user: 'alice',
    account: 'ml',
    partition: 'gpu',
    state,
    nodes: ['n1'],
    nodeList: 'n1',
    nodeCount: 1,
    gpusTotal: 8,
    submitTime: 10_000,
    startTime: 10_000,
    endTime,
    exitCode: 0,
    workDir: '/tmp',
    tres: '',
    templateId: 'overview',
  };
}

function flat(value: number, end = 17_200): JobSeries {
  const times: number[] = [];
  for (let t = 10_000; t <= end; t += 600) {
    times.push(t);
  }
  return { times, mean: times.map(() => value), min: times.map(() => value), max: times.map(() => value) };
}

function renderGrid(overrides: Partial<typeof DEFAULT_VIEW_STATE> = {}, extraJobs: JobRecord[] = []) {
  const jobs = [makeJob(1), makeJob(2), makeJob(3), makeJob(4), makeJob(5, 'FAILED'), ...extraJobs];
  const values = [60, 61, 59, 60, 20];
  const series = new Map(jobs.slice(0, 5).map((job, i) => [`a100-${job.jobId}`, flat(values[i])]));
  const state = { ...DEFAULT_VIEW_STATE, ...overrides };
  const model = buildCompareView({ jobs, series, failedJobKeys: new Set(['a100-6']), loading: false, view: state, now: NOW });
  const handlers = {
    onOpen: jest.fn(),
    onToggleSelect: jest.fn(),
    onSetBaseline: jest.fn(),
    onOpenDashboard: jest.fn(),
  };
  render(<CompareGrid model={model} state={state} {...handlers} />);
  return handlers;
}

describe('CompareGrid', () => {
  beforeEach(() => {
    jest
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue({ left: 0, width: 200, top: 0, height: 96 } as DOMRect);
  });

  afterEach(() => jest.restoreAllMocks());

  it('renders one cell per job with the outlier first and flagged', () => {
    renderGrid();
    const cells = screen.getAllByRole('group');
    expect(cells).toHaveLength(5);
    expect(cells[0]).toHaveAccessibleName('Job 5');
    expect(cells[0]).toHaveAttribute('data-flagged', 'true');
    expect(within(cells[0]).getByText(/-40\.0 vs\. median/)).toBeInTheDocument();
    expect(within(cells[0]).getByTestId('marker-abnormal-end')).toBeInTheDocument();
  });

  it('does not highlight deviation when sorted by something else', () => {
    renderGrid({ sort: 'job-id' });
    expect(screen.getAllByRole('group').some((cell) => cell.hasAttribute('data-flagged'))).toBe(false);
  });

  it('syncs the hover cursor across every cell', () => {
    renderGrid();
    const charts = screen.getAllByRole('img', { name: /^Series for job/ });
    fireEvent.mouseMove(charts[0], { clientX: 100 });
    expect(screen.getAllByText(/^1h 0m: /)).toHaveLength(5);
    expect(screen.getAllByTestId('cursor')).toHaveLength(5);
    fireEvent.mouseLeave(charts[0]);
    expect(screen.queryAllByTestId('cursor')).toHaveLength(0);
  });

  it('opens on click and toggles selection on shift-click', () => {
    const handlers = renderGrid();
    const chart = within(screen.getAllByRole('group')[1]).getByRole('img', { name: /^Series for job/ });
    fireEvent.click(chart);
    expect(handlers.onOpen).toHaveBeenCalledTimes(1);
    fireEvent.click(chart, { shiftKey: true });
    expect(handlers.onToggleSelect).toHaveBeenCalledTimes(1);
  });

  it('exposes baseline and dashboard actions', () => {
    const handlers = renderGrid();
    const cell = screen.getAllByRole('group')[0];
    fireEvent.click(within(cell).getByRole('button', { name: 'Set as baseline' }));
    expect(handlers.onSetBaseline).toHaveBeenCalledWith(expect.objectContaining({ key: 'a100-5' }));
    fireEvent.click(within(cell).getByRole('button', { name: 'Open job dashboard' }));
    expect(handlers.onOpenDashboard).toHaveBeenCalledWith(expect.objectContaining({ key: 'a100-5' }));
  });

  it('shows error and no-data cells and the running note on the progress axis', () => {
    renderGrid({ xAxis: 'progress' }, [makeJob(6), makeJob(7, 'RUNNING', 0)]);
    expect(within(screen.getByRole('group', { name: 'Job 6' })).getByText("Couldn't load this job's series.")).toBeInTheDocument();
    const running = screen.getByRole('group', { name: 'Job 7' });
    expect(within(running).getByText('No data for this metric')).toBeInTheDocument();
    expect(within(running).getByText('running: progress relative to now')).toBeInTheDocument();
  });
});
```

`1h 0m` の根拠: X 軸は elapsed、ドメインは `[0, 7200]`。幅 200 の要素で `clientX=100` は中央なので 3600 秒 → `formatDuration(3600) = '1h 0m'`。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --testPathPatterns=JobCompare/CompareGrid.test`
Expected: FAIL（`Cannot find module './CompareGrid'`）

- [ ] **Step 3: Write minimal implementation**

`src/pages/JobCompare/CompareCell.tsx`:

```tsx
import React from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { IconButton, useStyles2, useTheme2 } from '@grafana/ui';
import { getJobStateTimelineColor } from '../JobSearch/jobStateStyles';
import { formatDuration } from '../JobSearch/jobTime';
import { ChartMarker, ChartSeries, CompareChart } from './CompareChart';
import { formatValue, formatXValue } from './chartScale';
import { ChartLineData, CompareCellModel, computeYDomain } from './compareView';
import { CompareXAxis } from './model';
import { valueAt } from './seriesTransform';

export interface CompareCellProps {
  cell: CompareCellModel;
  xAxis: CompareXAxis;
  xDomain: [number, number];
  yDomain: [number, number] | null;
  baselineLine: ChartLineData | null;
  height: number;
  showDeviation: boolean;
  selected: boolean;
  cursorX: number | null;
  onCursorChange: (x: number | null) => void;
  onOpen: (cell: CompareCellModel) => void;
  onToggleSelect: (cell: CompareCellModel) => void;
  onSetBaseline: (cell: CompareCellModel) => void;
  onOpenDashboard: (cell: CompareCellModel) => void;
}

export type CompareCellActions = Pick<CompareCellProps, 'onOpen' | 'onToggleSelect' | 'onSetBaseline' | 'onOpenDashboard'>;

function getStyles(theme: GrafanaTheme2) {
  return {
    cell: css({
      border: `1px solid ${theme.colors.border.weak}`,
      borderRadius: theme.shape.radius.default,
      padding: theme.spacing(0.75, 1),
      background: theme.colors.background.primary,
      minWidth: 0,
    }),
    flagged: css({ borderColor: theme.colors.error.border }),
    selected: css({ outline: `2px solid ${theme.colors.primary.border}` }),
    header: css({
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: theme.spacing(1),
      fontSize: theme.typography.bodySmall.fontSize,
    }),
    title: css({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
    dot: css({ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', marginRight: 6 }),
    tag: css({ marginLeft: 6, color: theme.colors.text.secondary }),
    actions: css({ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0, color: theme.colors.text.secondary }),
    placeholder: css({
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: theme.colors.text.secondary,
      background: theme.colors.background.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
    }),
    footer: css({
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }),
  };
}

function cursorLabel(cursorX: number, xAxis: CompareXAxis, durationSec: number): string {
  if (xAxis === 'progress') {
    return `${formatXValue(cursorX, 'progress')} (${formatDuration(Math.round((cursorX / 100) * durationSec))} elapsed)`;
  }
  return formatXValue(cursorX, xAxis);
}

export function CompareCell({
  cell,
  xAxis,
  xDomain,
  yDomain,
  baselineLine,
  height,
  showDeviation,
  selected,
  cursorX,
  onCursorChange,
  onOpen,
  onToggleSelect,
  onSetBaseline,
  onOpenDashboard,
}: CompareCellProps) {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const { job, line, stats, deviation } = cell;
  const flagged = showDeviation && Boolean(deviation?.flagged);

  const renderBody = () => {
    if (cell.status === 'loading') {
      return <div className={styles.placeholder} style={{ height }} aria-label="Loading series" />;
    }
    if (cell.status === 'error') {
      return (
        <div className={styles.placeholder} style={{ height }}>
          Couldn&apos;t load this job&apos;s series.
        </div>
      );
    }
    if (cell.status === 'no-data' || !line) {
      return (
        <div className={styles.placeholder} style={{ height }}>
          No data for this metric
        </div>
      );
    }
    const series: ChartSeries[] = [];
    if (baselineLine && !cell.isBaseline) {
      series.push({ id: 'baseline', x: baselineLine.x, y: baselineLine.y, color: theme.colors.text.secondary, width: 1, dashed: true });
    }
    series.push({ id: 'job', x: line.x, y: line.y, band: line.band, color: theme.colors.primary.main });
    const lastX = line.x[line.x.length - 1];
    const markers: ChartMarker[] = [];
    if (cell.isRunning && lastX !== undefined) {
      markers.push({ x: lastX, kind: 'running' });
    }
    if (cell.endedAbnormally && lastX !== undefined) {
      markers.push({ x: lastX, kind: 'abnormal-end' });
    }
    return (
      <CompareChart
        series={series}
        xDomain={xDomain}
        yDomain={yDomain ?? computeYDomain([line, baselineLine]) ?? [0, 1]}
        height={height}
        ariaLabel={`Series for job ${job.jobId}`}
        cursorX={cursorX}
        cursorColor={theme.colors.text.secondary}
        markers={markers}
        markerColor={theme.colors.error.text}
        onCursorChange={onCursorChange}
        onClick={(event) => (event.shiftKey || event.metaKey || event.ctrlKey ? onToggleSelect(cell) : onOpen(cell))}
      />
    );
  };

  const readout =
    cursorX !== null && line
      ? `${cursorLabel(cursorX, xAxis, stats.durationSec)}: ${formatValue(valueAt(line.x, line.y, cursorX))}`
      : [
          `mean ${formatValue(stats.mean)}`,
          `p95 ${formatValue(stats.p95)}`,
          formatDuration(stats.durationSec),
          job.gpusTotal > 0 ? `${job.gpusTotal} GPU` : null,
        ]
          .filter(Boolean)
          .join(' · ');

  return (
    <div
      role="group"
      aria-label={`Job ${job.jobId}`}
      data-flagged={flagged ? 'true' : undefined}
      className={cx(styles.cell, flagged && styles.flagged, selected && styles.selected)}
    >
      <div className={styles.header}>
        <span className={styles.title}>
          <span className={styles.dot} style={{ background: getJobStateTimelineColor(job.state) }} />
          {`#${job.jobId} ${job.name}`}
          {cell.isBaseline && <span className={styles.tag}>baseline</span>}
        </span>
        <span className={styles.actions}>
          <span>{job.state.toLowerCase()}</span>
          <IconButton
            name="anchor"
            size="sm"
            tooltip={cell.isBaseline ? 'Clear baseline' : 'Set as baseline'}
            onClick={() => onSetBaseline(cell)}
          />
          <IconButton name="external-link-alt" size="sm" tooltip="Open job dashboard" onClick={() => onOpenDashboard(cell)} />
        </span>
      </div>
      {renderBody()}
      <div className={styles.footer}>{readout}</div>
      {showDeviation && deviation && (
        <div className={styles.footer}>
          {`${deviation.signedMean >= 0 ? '+' : ''}${formatValue(deviation.signedMean)} vs. median`}
        </div>
      )}
      {xAxis === 'progress' && cell.isRunning && <div className={styles.footer}>running: progress relative to now</div>}
    </div>
  );
}
```

注: `IconButton` の `name` は `IconName` 型。`anchor` が型エラーになる場合は `node_modules/@grafana/data/dist/.../icon.d.ts`（`availableIconsIndex`）から近いアイコン（例: `bookmark`）を選ぶ。

`formatValue(-40)` は `'-40.0'`（abs ≥ 1 なので 1 桁）なので、テストの `/-40\.0 vs\. median/` に一致する。

`src/pages/JobCompare/CompareGrid.tsx`:

```tsx
import React, { useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';
import { CompareCell, CompareCellActions } from './CompareCell';
import { formatValue, formatXValue } from './chartScale';
import { CompareViewModel } from './compareView';
import { CompareViewState } from './model';

interface Props extends CompareCellActions {
  model: CompareViewModel;
  state: CompareViewState;
}

function getStyles(theme: GrafanaTheme2) {
  return {
    axisNote: css({
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
      marginBottom: theme.spacing(1),
    }),
    grid: css({ display: 'grid', gap: theme.spacing(1) }),
  };
}

export function CompareGrid({ model, state, onOpen, onToggleSelect, onSetBaseline, onOpenDashboard }: Props) {
  const styles = useStyles2(getStyles);
  const [cursorX, setCursorX] = useState<number | null>(null);
  const height = state.columns === '6' ? 72 : 96;
  const template =
    state.columns === 'auto' ? 'repeat(auto-fill, minmax(260px, 1fr))' : `repeat(${state.columns}, minmax(0, 1fr))`;
  const xNote = `X: ${formatXValue(model.xDomain[0], state.xAxis)} – ${formatXValue(model.xDomain[1], state.xAxis)}`;
  const yNote = model.yDomain ? ` · Y: ${formatValue(model.yDomain[0])} – ${formatValue(model.yDomain[1])}` : '';

  return (
    <div>
      <div className={styles.axisNote}>{xNote + yNote}</div>
      <div className={styles.grid} style={{ gridTemplateColumns: template }}>
        {model.cells.map((cell) => (
          <CompareCell
            key={cell.key}
            cell={cell}
            xAxis={state.xAxis}
            xDomain={model.xDomain}
            yDomain={model.yDomain}
            baselineLine={model.baselineLine}
            height={height}
            showDeviation={state.sort === 'deviation'}
            selected={state.selectedJobIds.includes(String(cell.job.jobId))}
            cursorX={cursorX}
            onCursorChange={setCursorX}
            onOpen={onOpen}
            onToggleSelect={onToggleSelect}
            onSetBaseline={onSetBaseline}
            onOpenDashboard={onOpenDashboard}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --testPathPatterns=JobCompare/CompareGrid.test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pages/JobCompare/CompareCell.tsx src/pages/JobCompare/CompareGrid.tsx src/pages/JobCompare/CompareGrid.test.tsx
git commit -m "feat: add metric compare grid with synced cursor"
```

---

### Task 10: オーバーレイ表示

**Files:**
- Create: `src/pages/JobCompare/CompareOverlay.tsx`
- Test: `src/pages/JobCompare/CompareOverlay.test.tsx`

**Interfaces:**
- Consumes: `CompareChart`, `ChartSeries`（Task 8）、`formatValue`, `formatXValue`（Task 8）、`CompareViewModel`, `computeYDomain`, `selectOverlayCells`（Task 7）、`CompareViewState`, `OVERLAY_LINE_LIMIT`（Task 1）、`formatDuration`
- Produces: `CompareOverlay(props: { model: CompareViewModel; state: CompareViewState; height?: number })`。凡例行は `data-testid="legend-<jobId>"`、ベースライン行は `data-testid="legend-baseline"`。

- [ ] **Step 1: Write the failing test**

`src/pages/JobCompare/CompareOverlay.test.tsx`:

```tsx
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { JobRecord } from '../../api/types';
import { CompareOverlay } from './CompareOverlay';
import { buildCompareView } from './compareView';
import { DEFAULT_VIEW_STATE } from './model';
import { JobSeries } from './seriesTransform';

function makeJob(jobId: number): JobRecord {
  return {
    clusterId: 'a100',
    jobId,
    name: `train-${jobId}`,
    user: 'alice',
    account: 'ml',
    partition: 'gpu',
    state: 'COMPLETED',
    nodes: ['n1'],
    nodeList: 'n1',
    nodeCount: 1,
    gpusTotal: 8,
    submitTime: 0,
    startTime: 1000,
    endTime: 4600,
    exitCode: 0,
    workDir: '/tmp',
    tres: '',
    templateId: 'overview',
  };
}

function flat(value: number): JobSeries {
  return { times: [1000, 2800, 4600], mean: [value, value, value], min: [value, value, value], max: [value, value, value] };
}

function renderOverlay(count: number, overrides: Partial<typeof DEFAULT_VIEW_STATE> = {}) {
  const jobs = Array.from({ length: count }, (_, i) => makeJob(i + 1));
  const state = { ...DEFAULT_VIEW_STATE, layout: 'overlay' as const, sort: 'job-id' as const, ...overrides };
  const model = buildCompareView({
    jobs,
    series: new Map(jobs.map((job) => [`a100-${job.jobId}`, flat(job.jobId)])),
    failedJobKeys: new Set(),
    loading: false,
    view: state,
    now: 10_000,
  });
  render(<CompareOverlay model={model} state={state} />);
}

describe('CompareOverlay', () => {
  it('draws one line and one legend row per job', () => {
    renderOverlay(3);
    expect(screen.getByRole('img', { name: 'Overlay of job series' })).toBeInTheDocument();
    expect(screen.getByTestId('legend-1')).toHaveTextContent('#1');
    expect(screen.getByTestId('line-a100-3')).toBeInTheDocument();
    expect(screen.queryByText(/Overlay shows up to/)).toBeNull();
  });

  it('dims other lines while a legend row is hovered', () => {
    renderOverlay(3);
    fireEvent.mouseEnter(screen.getByTestId('legend-2'));
    expect(screen.getByTestId('line-a100-1')).toHaveAttribute('stroke-opacity', '0.2');
    expect(screen.getByTestId('line-a100-2')).toHaveAttribute('stroke-opacity', '1');
    fireEvent.mouseLeave(screen.getByTestId('legend-2'));
    expect(screen.getByTestId('line-a100-1')).toHaveAttribute('stroke-opacity', '1');
  });

  it('warns when more than 10 jobs are available', () => {
    renderOverlay(12);
    expect(screen.getByText('Overlay shows up to 10 jobs')).toBeInTheDocument();
    expect(screen.getAllByTestId(/^legend-\d+$/)).toHaveLength(10);
  });

  it('draws the baseline as a separate thick line', () => {
    renderOverlay(3, { baselineJobId: '2' });
    expect(screen.getByTestId('line-baseline')).toHaveAttribute('stroke-width', '3');
    expect(screen.queryByTestId('line-a100-2')).toBeNull();
    expect(screen.getByTestId('legend-baseline')).toHaveTextContent('#2 (baseline)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --testPathPatterns=JobCompare/CompareOverlay.test`
Expected: FAIL（`Cannot find module './CompareOverlay'`）

- [ ] **Step 3: Write minimal implementation**

`src/pages/JobCompare/CompareOverlay.tsx`:

```tsx
import React, { useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Alert, useStyles2, useTheme2 } from '@grafana/ui';
import { formatDuration } from '../JobSearch/jobTime';
import { ChartSeries, CompareChart } from './CompareChart';
import { formatValue, formatXValue } from './chartScale';
import { CompareCellModel, CompareViewModel, computeYDomain, selectOverlayCells } from './compareView';
import { CompareViewState, OVERLAY_LINE_LIMIT } from './model';

interface Props {
  model: CompareViewModel;
  state: CompareViewState;
  height?: number;
}

const BASELINE_ID = 'baseline';

function getStyles(theme: GrafanaTheme2) {
  return {
    axisNote: css({
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
      margin: theme.spacing(0.5, 0, 1),
    }),
    legend: css({
      width: '100%',
      borderCollapse: 'collapse',
      fontSize: theme.typography.bodySmall.fontSize,
      'th, td': { textAlign: 'left', padding: theme.spacing(0.5, 1), borderBottom: `1px solid ${theme.colors.border.weak}` },
      'tbody tr:hover': { background: theme.colors.action.hover },
    }),
    swatch: css({ display: 'inline-block', width: 12, height: 3, verticalAlign: 'middle' }),
    empty: css({ color: theme.colors.text.secondary, padding: theme.spacing(2) }),
  };
}

export function CompareOverlay({ model, state, height = 360 }: Props) {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const { cells, truncated } = useMemo(
    () => selectOverlayCells(model.cells, state.selectedJobIds),
    [model.cells, state.selectedJobIds]
  );
  const lineCells = cells.filter((cell) => !cell.isBaseline);
  const baselineCell = model.baselineLine ? model.cells.find((cell) => cell.isBaseline) ?? null : null;
  const palette = theme.visualization.palette;
  const colorFor = (index: number) => theme.visualization.getColorByName(palette[index % palette.length]);
  const opacityFor = (id: string) => (highlighted && highlighted !== id ? 0.2 : 1);

  const series: ChartSeries[] = [];
  if (model.baselineLine) {
    series.push({
      id: BASELINE_ID,
      x: model.baselineLine.x,
      y: model.baselineLine.y,
      color: theme.colors.text.secondary,
      width: 3,
      opacity: opacityFor(BASELINE_ID),
    });
  }
  lineCells.forEach((cell, index) => {
    series.push({ id: cell.key, x: cell.line!.x, y: cell.line!.y, color: colorFor(index), opacity: opacityFor(cell.key) });
  });
  const yDomain = model.yDomain ?? computeYDomain([...lineCells.map((c) => c.line), model.baselineLine]) ?? [0, 1];

  const renderRow = (cell: CompareCellModel, id: string, color: string, testId: string) => (
    <tr key={id} data-testid={testId} onMouseEnter={() => setHighlighted(id)} onMouseLeave={() => setHighlighted(null)}>
      <td>
        <span className={styles.swatch} style={{ background: color }} />
      </td>
      <td>{`#${cell.job.jobId}${cell.isBaseline ? ' (baseline)' : ''}`}</td>
      <td>{cell.job.name}</td>
      <td>{formatValue(cell.stats.mean)}</td>
      <td>{formatValue(cell.stats.p95)}</td>
      <td>{formatDuration(cell.stats.durationSec)}</td>
    </tr>
  );

  return (
    <div>
      {truncated && (
        <Alert severity="info" title={`Overlay shows up to ${OVERLAY_LINE_LIMIT} jobs`}>
          Shift-click cells in grid view to choose which jobs to overlay.
        </Alert>
      )}
      {series.length === 0 ? (
        <div className={styles.empty}>No loaded series to overlay yet.</div>
      ) : (
        <CompareChart series={series} xDomain={model.xDomain} yDomain={yDomain} height={height} ariaLabel="Overlay of job series" />
      )}
      <div className={styles.axisNote}>
        {`X: ${formatXValue(model.xDomain[0], state.xAxis)} – ${formatXValue(model.xDomain[1], state.xAxis)} · Y: ${formatValue(yDomain[0])} – ${formatValue(yDomain[1])}`}
      </div>
      <table className={styles.legend}>
        <thead>
          <tr>
            <th aria-label="Color" />
            <th>Job</th>
            <th>Name</th>
            <th>Mean</th>
            <th>P95</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          {baselineCell && renderRow(baselineCell, BASELINE_ID, theme.colors.text.secondary, 'legend-baseline')}
          {lineCells.map((cell, index) => renderRow(cell, cell.key, colorFor(index), `legend-${cell.job.jobId}`))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --testPathPatterns=JobCompare/CompareOverlay.test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pages/JobCompare/CompareOverlay.tsx src/pages/JobCompare/CompareOverlay.test.tsx
git commit -m "feat: add overlay view for metric compare"
```

---

### Task 11: 表示オプションとメトリクス選択

**Files:**
- Create: `src/pages/JobCompare/CompareToolbar.tsx`
- Create: `src/pages/JobCompare/MetricPicker.tsx`
- Test: `src/pages/JobCompare/CompareToolbar.test.tsx`
- Test: `src/pages/JobCompare/MetricPicker.test.tsx`

**Interfaces:**
- Consumes: `CompareViewState`, `isValidMetricName`（Task 1）、`buildMetricOptions`（Task 5）、`RATE_WINDOW`（Task 4）、`PrometheusMetricType`
- Produces:
  - `CompareToolbar(props: { state: CompareViewState; onChange: (patch: Partial<CompareViewState>) => void; selectedCount: number; onOverlaySelected: () => void; onClearSelection: () => void })`
  - `MetricPicker(props: { names: string[]; loading: boolean; value: string; metricType: PrometheusMetricType | null; onChange: (name: string) => void })`

- [ ] **Step 1: Write the failing tests**

`src/pages/JobCompare/CompareToolbar.test.tsx`:

```tsx
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { CompareToolbar } from './CompareToolbar';
import { DEFAULT_VIEW_STATE } from './model';

function renderToolbar(overrides: Partial<typeof DEFAULT_VIEW_STATE> = {}, selectedCount = 0) {
  const props = {
    state: { ...DEFAULT_VIEW_STATE, ...overrides },
    onChange: jest.fn(),
    selectedCount,
    onOverlaySelected: jest.fn(),
    onClearSelection: jest.fn(),
  };
  render(<CompareToolbar {...props} />);
  return props;
}

describe('CompareToolbar', () => {
  it('patches layout, x axis, and y scale', () => {
    const props = renderToolbar();
    fireEvent.click(screen.getByRole('radio', { name: 'Overlay' }));
    expect(props.onChange).toHaveBeenCalledWith({ layout: 'overlay' });
    fireEvent.click(screen.getByRole('radio', { name: 'Progress' }));
    expect(props.onChange).toHaveBeenCalledWith({ xAxis: 'progress' });
    fireEvent.click(screen.getByRole('radio', { name: 'Independent' }));
    expect(props.onChange).toHaveBeenCalledWith({ yScale: 'independent' });
  });

  it('shows the elapsed range only on the elapsed axis', () => {
    renderToolbar();
    expect(screen.getByText('Elapsed range')).toBeInTheDocument();
  });

  it('hides the elapsed range on other axes', () => {
    renderToolbar({ xAxis: 'progress' });
    expect(screen.queryByText('Elapsed range')).toBeNull();
  });

  it('offers selection actions only when jobs are selected', () => {
    renderToolbar();
    expect(screen.queryByRole('button', { name: /Overlay selected/ })).toBeNull();
  });

  it('runs selection actions', () => {
    const props = renderToolbar({}, 2);
    fireEvent.click(screen.getByRole('button', { name: 'Overlay selected (2)' }));
    expect(props.onOverlaySelected).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(props.onClearSelection).toHaveBeenCalled();
  });
});
```

`src/pages/JobCompare/MetricPicker.test.tsx`:

```tsx
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MetricPicker } from './MetricPicker';

describe('MetricPicker', () => {
  it('shows a placeholder without a metric', () => {
    render(<MetricPicker names={['node_load1']} loading={false} value="" metricType={null} onChange={jest.fn()} />);
    expect(screen.getByText('Select a metric')).toBeInTheDocument();
    expect(screen.queryByText('gauge')).toBeNull();
  });

  it('shows the metric type and the rate() note for counters', () => {
    render(
      <MetricPicker
        names={['node_network_receive_bytes_total']}
        loading={false}
        value="node_network_receive_bytes_total"
        metricType="counter"
        onChange={jest.fn()}
      />
    );
    expect(screen.getByText('node_network_receive_bytes_total')).toBeInTheDocument();
    expect(screen.getByText('counter')).toBeInTheDocument();
    expect(screen.getByText('rate() applied')).toBeInTheDocument();
  });

  it('omits the rate() note for gauges', () => {
    render(<MetricPicker names={[]} loading={false} value="node_load1" metricType="gauge" onChange={jest.fn()} />);
    expect(screen.getByText('gauge')).toBeInTheDocument();
    expect(screen.queryByText('rate() applied')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest --testPathPatterns="JobCompare/(CompareToolbar|MetricPicker).test"`
Expected: FAIL（モジュールが存在しない）

- [ ] **Step 3: Write minimal implementation**

`src/pages/JobCompare/CompareToolbar.tsx`:

```tsx
import React from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, SelectableValue } from '@grafana/data';
import { Button, InlineField, RadioButtonGroup, Select, useStyles2 } from '@grafana/ui';
import {
  CompareColumns,
  CompareLayout,
  CompareReduce,
  CompareSort,
  CompareViewState,
  CompareXAxis,
  CompareYScale,
} from './model';

interface Props {
  state: CompareViewState;
  onChange: (patch: Partial<CompareViewState>) => void;
  selectedCount: number;
  onOverlaySelected: () => void;
  onClearSelection: () => void;
}

const LAYOUT_OPTIONS: Array<SelectableValue<CompareLayout>> = [
  { label: 'Grid', value: 'grid' },
  { label: 'Overlay', value: 'overlay' },
];
const X_AXIS_OPTIONS: Array<SelectableValue<CompareXAxis>> = [
  { label: 'Elapsed', value: 'elapsed' },
  { label: 'Progress', value: 'progress' },
  { label: 'Absolute', value: 'absolute' },
];
const Y_SCALE_OPTIONS: Array<SelectableValue<CompareYScale>> = [
  { label: 'Shared', value: 'shared' },
  { label: 'Independent', value: 'independent' },
];
const REDUCE_OPTIONS: Array<SelectableValue<CompareReduce>> = [
  { label: 'Mean + min/max band', value: 'band' },
  { label: 'Mean', value: 'mean' },
  { label: 'Max', value: 'max' },
  { label: 'Min', value: 'min' },
];
const SORT_OPTIONS: Array<SelectableValue<CompareSort>> = [
  { label: 'Deviation from median', value: 'deviation' },
  { label: 'Mean (high to low)', value: 'mean-desc' },
  { label: 'Mean (low to high)', value: 'mean-asc' },
  { label: 'Start time', value: 'start' },
  { label: 'Duration', value: 'duration' },
  { label: 'Job ID', value: 'job-id' },
];
const COLUMN_OPTIONS: Array<SelectableValue<CompareColumns>> = [
  { label: 'Auto', value: 'auto' },
  { label: '2', value: '2' },
  { label: '3', value: '3' },
  { label: '4', value: '4' },
  { label: '6', value: '6' },
];
const ELAPSED_LIMIT_OPTIONS: Array<SelectableValue<number>> = [
  { label: 'Whole job', value: 0 },
  { label: 'First 1h', value: 1 },
  { label: 'First 6h', value: 6 },
  { label: 'First 24h', value: 24 },
];

function getStyles(theme: GrafanaTheme2) {
  return {
    toolbar: css({
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: theme.spacing(1),
      padding: theme.spacing(1, 0),
      marginBottom: theme.spacing(1),
      borderTop: `1px solid ${theme.colors.border.weak}`,
      borderBottom: `1px solid ${theme.colors.border.weak}`,
    }),
  };
}

export function CompareToolbar({ state, onChange, selectedCount, onOverlaySelected, onClearSelection }: Props) {
  const styles = useStyles2(getStyles);
  return (
    <div className={styles.toolbar}>
      <InlineField label="Layout">
        <RadioButtonGroup size="sm" options={LAYOUT_OPTIONS} value={state.layout} onChange={(layout) => onChange({ layout })} />
      </InlineField>
      <InlineField label="X axis">
        <RadioButtonGroup size="sm" options={X_AXIS_OPTIONS} value={state.xAxis} onChange={(xAxis) => onChange({ xAxis })} />
      </InlineField>
      {state.xAxis === 'elapsed' && (
        <InlineField label="Elapsed range">
          <Select
            aria-label="Elapsed range"
            width={14}
            options={ELAPSED_LIMIT_OPTIONS}
            value={state.elapsedLimitHours}
            onChange={(option) => onChange({ elapsedLimitHours: option.value ?? 0 })}
          />
        </InlineField>
      )}
      <InlineField label="Reduce">
        <Select
          aria-label="Reduce"
          width={24}
          options={REDUCE_OPTIONS}
          value={state.reduce}
          onChange={(option) => option.value && onChange({ reduce: option.value })}
        />
      </InlineField>
      <InlineField label="Y">
        <RadioButtonGroup size="sm" options={Y_SCALE_OPTIONS} value={state.yScale} onChange={(yScale) => onChange({ yScale })} />
      </InlineField>
      <InlineField label="Sort">
        <Select
          aria-label="Sort"
          width={26}
          options={SORT_OPTIONS}
          value={state.sort}
          onChange={(option) => option.value && onChange({ sort: option.value })}
        />
      </InlineField>
      {state.layout === 'grid' && (
        <InlineField label="Columns">
          <Select
            aria-label="Columns"
            width={10}
            options={COLUMN_OPTIONS}
            value={state.columns}
            onChange={(option) => option.value && onChange({ columns: option.value })}
          />
        </InlineField>
      )}
      {selectedCount > 0 && (
        <>
          <Button size="sm" variant="secondary" onClick={onOverlaySelected}>
            {`Overlay selected (${selectedCount})`}
          </Button>
          <Button size="sm" variant="secondary" fill="text" onClick={onClearSelection}>
            Clear selection
          </Button>
        </>
      )}
    </div>
  );
}
```

`src/pages/JobCompare/MetricPicker.tsx`:

```tsx
import React, { useMemo } from 'react';
import { Badge, InlineField, Select } from '@grafana/ui';
import { PrometheusMetricType } from '../JobDashboard/scenes/metricDiscovery';
import { buildMetricOptions } from './metricCatalog';
import { RATE_WINDOW } from './metricQuery';
import { isValidMetricName } from './model';

interface Props {
  names: string[];
  loading: boolean;
  value: string;
  metricType: PrometheusMetricType | null;
  onChange: (name: string) => void;
}

export function MetricPicker({ names, loading, value, metricType, onChange }: Props) {
  const options = useMemo(() => buildMetricOptions(names), [names]);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <InlineField label="Metric">
        <Select
          aria-label="Metric"
          width={50}
          options={options}
          value={value ? { label: value, value } : null}
          isLoading={loading}
          placeholder="Select a metric"
          allowCustomValue
          onChange={(option) => {
            const name = option?.value;
            if (name && isValidMetricName(name)) {
              onChange(name);
            }
          }}
        />
      </InlineField>
      {value && metricType && <Badge text={metricType} color="blue" />}
      {value && metricType === 'counter' && (
        <Badge text="rate() applied" color="orange" tooltip={`Counters are shown as rate(...[${RATE_WINDOW}])`} />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest --testPathPatterns="JobCompare/(CompareToolbar|MetricPicker).test" && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pages/JobCompare/CompareToolbar.tsx src/pages/JobCompare/CompareToolbar.test.tsx src/pages/JobCompare/MetricPicker.tsx src/pages/JobCompare/MetricPicker.test.tsx
git commit -m "feat: add metric compare toolbar and metric picker"
```

---

### Task 12: ジョブ集合バー

**Files:**
- Create: `src/pages/JobCompare/JobSetBar.tsx`
- Test: `src/pages/JobCompare/JobSetBar.test.tsx`

**Interfaces:**
- Consumes: `JobFilters`（`JobSearch/JobFilters.tsx`、props: `clusters, filters, loadingClusters, onChange, onSelectMetadata, onSearch, onOpenJob`）、`applyFilterValue`, `MetadataField`, `SearchFilters`、`navigateToJobPage`、`timelineRangeToRawValues`、`formatDuration`、`COMPARE_JOB_LIMIT`, `JobSetMode`（Task 1）
- Produces:
  - `describeFilters(filters: Partial<SearchFilters>): string[]`
  - `JobSetBar(props: { clusters: ClusterSummary[]; loadingClusters: boolean; mode: JobSetMode; filters: SearchFilters; appliedFilters: SearchFilters; timeRange: TimeRange; loading: boolean; error: string | null; shownCount: number; total: number; hiddenNonGpu: number; missingIds: string[]; baseline: JobRecord | null; onFiltersChange: (filters: SearchFilters) => void; onApplyFilter: (filters?: SearchFilters) => void; onTimeRangeChange: (range: TimeRange) => void; onSwitchToFilter: () => void; onClearBaseline: () => void })`

- [ ] **Step 1: Write the failing test**

`src/pages/JobCompare/JobSetBar.test.tsx`:

```tsx
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { JobRecord } from '../../api/types';
import { makeRelativeTimeRange } from '../JobSearch/timelineRange';
import { describeFilters, JobSetBar } from './JobSetBar';

jest.mock('../../api/slurmApi', () => ({
  listJobMetadataOptions: jest.fn().mockResolvedValue({ values: [] }),
}));

jest.mock('../JobSearch/navigation', () => ({
  navigateToJobPage: jest.fn(),
}));

jest.mock('@grafana/ui', () => {
  const actual = jest.requireActual('@grafana/ui');
  return {
    ...actual,
    TimeRangeInput: () => <div data-testid="time-range-input" />,
  };
});

const cluster = {
  id: 'a100',
  displayName: 'A100',
  slurmClusterName: 'slurm-a100',
  metricsDatasourceUid: 'prom',
  metricsType: 'prometheus' as const,
  aggregationNodeLabels: ['instance'],
  instanceLabel: 'instance',
  nodeMatcherMode: 'hostname' as const,
  defaultTemplateId: 'overview',
  metricsFilterLabel: '',
  metricsFilterValue: '',
};

const baseline = { jobId: 10231, name: 'llm-pretrain' } as JobRecord;

function renderBar(overrides: Partial<React.ComponentProps<typeof JobSetBar>> = {}) {
  const props: React.ComponentProps<typeof JobSetBar> = {
    clusters: [cluster],
    loadingClusters: false,
    mode: 'filter',
    filters: { clusterId: 'a100', user: 'alice' },
    appliedFilters: { clusterId: 'a100', user: 'alice' },
    timeRange: makeRelativeTimeRange('now-7d', 'now'),
    loading: false,
    error: null,
    shownCount: 12,
    total: 12,
    hiddenNonGpu: 0,
    missingIds: [],
    baseline: null,
    onFiltersChange: jest.fn(),
    onApplyFilter: jest.fn(),
    onTimeRangeChange: jest.fn(),
    onSwitchToFilter: jest.fn(),
    onClearBaseline: jest.fn(),
    ...overrides,
  };
  render(<JobSetBar {...props} />);
  return props;
}

describe('describeFilters', () => {
  it('summarizes the active filters', () => {
    expect(
      describeFilters({ clusterId: 'a100', user: 'alice', partition: 'gpu', nodesMin: '2', elapsedMin: '3600', jobId: '9' })
    ).toEqual(['user=alice', 'partition=gpu', 'nodes>=2', 'elapsed>=1h 0m']);
    expect(describeFilters({ clusterId: 'a100' })).toEqual([]);
  });
});

describe('JobSetBar', () => {
  it('summarizes the applied filter, time range, and count', () => {
    renderBar();
    expect(screen.getByText('A100')).toBeInTheDocument();
    expect(screen.getByText('user=alice')).toBeInTheDocument();
    expect(screen.getByText('now-7d to now')).toBeInTheDocument();
    expect(screen.getByText('12 jobs')).toBeInTheDocument();
  });

  it('explains the 48-job cap, hidden jobs, and missing jobs', () => {
    renderBar({ shownCount: 45, total: 213, hiddenNonGpu: 3, missingIds: ['7', '8'] });
    expect(screen.getByText('Showing 48 of 213 jobs. Narrow the filter to compare others.')).toBeInTheDocument();
    expect(screen.getByText('3 jobs hidden (no GPUs)')).toBeInTheDocument();
    expect(screen.getByText("Couldn't load jobs: 7, 8")).toBeInTheDocument();
  });

  it('opens the filter editor and applies it on search', () => {
    const props = renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Edit filter' }));
    expect(screen.getByTestId('time-range-input')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(props.onApplyFilter).toHaveBeenCalled();
  });

  it('describes pick mode and offers switching back to the filter', () => {
    const props = renderBar({ mode: 'pick', shownCount: 2, total: 2 });
    expect(screen.getByText('2 picked jobs')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit filter' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Use search filter' }));
    expect(props.onSwitchToFilter).toHaveBeenCalled();
  });

  it('shows and clears the baseline', () => {
    const props = renderBar({ baseline });
    expect(screen.getByText('Baseline: #10231 llm-pretrain')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear baseline' }));
    expect(props.onClearBaseline).toHaveBeenCalled();
  });

  it('shows the job loading error', () => {
    renderBar({ error: 'boom' });
    expect(screen.getByText('boom')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --testPathPatterns=JobCompare/JobSetBar.test`
Expected: FAIL（`Cannot find module './JobSetBar'`）

- [ ] **Step 3: Write minimal implementation**

`src/pages/JobCompare/JobSetBar.tsx`:

```tsx
import React, { useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, TimeRange } from '@grafana/data';
import { Alert, Button, IconButton, TimeRangeInput, useStyles2 } from '@grafana/ui';
import { ClusterSummary, JobRecord } from '../../api/types';
import { JobFilters } from '../JobSearch/JobFilters';
import { formatDuration } from '../JobSearch/jobTime';
import { applyFilterValue, MetadataField, SearchFilters } from '../JobSearch/model';
import { navigateToJobPage } from '../JobSearch/navigation';
import { timelineRangeToRawValues } from '../JobSearch/timelineRange';
import { COMPARE_JOB_LIMIT, JobSetMode } from './model';

interface Props {
  clusters: ClusterSummary[];
  loadingClusters: boolean;
  mode: JobSetMode;
  filters: SearchFilters;
  appliedFilters: SearchFilters;
  timeRange: TimeRange;
  loading: boolean;
  error: string | null;
  shownCount: number;
  total: number;
  hiddenNonGpu: number;
  missingIds: string[];
  baseline: JobRecord | null;
  onFiltersChange: (filters: SearchFilters) => void;
  onApplyFilter: (filters?: SearchFilters) => void;
  onTimeRangeChange: (range: TimeRange) => void;
  onSwitchToFilter: () => void;
  onClearBaseline: () => void;
}

const PLAIN_FILTERS: Array<[keyof SearchFilters, string]> = [
  ['name', 'name'],
  ['user', 'user'],
  ['account', 'account'],
  ['partition', 'partition'],
  ['state', 'state'],
  ['nodeNames', 'node'],
];

export function describeFilters(filters: Partial<SearchFilters>): string[] {
  const parts: string[] = [];
  for (const [field, label] of PLAIN_FILTERS) {
    const value = filters[field];
    if (value) {
      parts.push(`${label}=${value}`);
    }
  }
  if (filters.nodesMin) {
    parts.push(`nodes>=${filters.nodesMin}`);
  }
  if (filters.nodesMax) {
    parts.push(`nodes<=${filters.nodesMax}`);
  }
  if (filters.elapsedMin) {
    parts.push(`elapsed>=${formatDuration(Number(filters.elapsedMin))}`);
  }
  if (filters.elapsedMax) {
    parts.push(`elapsed<=${formatDuration(Number(filters.elapsedMax))}`);
  }
  return parts;
}

function getStyles(theme: GrafanaTheme2) {
  return {
    bar: css({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: theme.spacing(1), margin: theme.spacing(1, 0) }),
    label: css({ color: theme.colors.text.secondary }),
    chip: css({
      border: `1px solid ${theme.colors.border.medium}`,
      borderRadius: theme.shape.radius.default,
      padding: theme.spacing(0.25, 1),
      fontSize: theme.typography.bodySmall.fontSize,
    }),
    muted: css({ color: theme.colors.text.secondary, fontSize: theme.typography.bodySmall.fontSize }),
    editor: css({ padding: theme.spacing(1), background: theme.colors.background.secondary, marginBottom: theme.spacing(1) }),
  };
}

export function JobSetBar({
  clusters,
  loadingClusters,
  mode,
  filters,
  appliedFilters,
  timeRange,
  loading,
  error,
  shownCount,
  total,
  hiddenNonGpu,
  missingIds,
  baseline,
  onFiltersChange,
  onApplyFilter,
  onTimeRangeChange,
  onSwitchToFilter,
  onClearBaseline,
}: Props) {
  const styles = useStyles2(getStyles);
  const [editing, setEditing] = useState(false);
  const clusterName = clusters.find((c) => c.id === appliedFilters.clusterId)?.displayName ?? appliedFilters.clusterId;
  const chips = describeFilters(appliedFilters);
  const raw = timelineRangeToRawValues(timeRange);

  const selectMetadata = (field: MetadataField, value: string) => {
    const next = applyFilterValue(filters, field, value);
    onFiltersChange(next);
    onApplyFilter(next);
  };

  return (
    <div>
      <div className={styles.bar}>
        <span className={styles.label}>Cluster</span>
        <span className={styles.chip}>{clusterName}</span>
        <span className={styles.label}>Jobs</span>
        {mode === 'filter' ? (
          <>
            {chips.length > 0 ? (
              chips.map((chip) => (
                <span key={chip} className={styles.chip}>
                  {chip}
                </span>
              ))
            ) : (
              <span className={styles.chip}>All jobs</span>
            )}
            <span className={styles.chip}>{`${raw.from} to ${raw.to}`}</span>
            <Button size="sm" variant="secondary" icon="filter" onClick={() => setEditing((current) => !current)}>
              {editing ? 'Hide filter' : 'Edit filter'}
            </Button>
          </>
        ) : (
          <>
            <span className={styles.chip}>{`${shownCount} picked jobs`}</span>
            <Button size="sm" variant="secondary" onClick={onSwitchToFilter}>
              Use search filter
            </Button>
          </>
        )}
        <span className={styles.muted}>{loading ? 'Loading jobs…' : `${shownCount} jobs`}</span>
        {hiddenNonGpu > 0 && <span className={styles.muted}>{`${hiddenNonGpu} jobs hidden (no GPUs)`}</span>}
        {baseline && (
          <span className={styles.chip}>
            {`Baseline: #${baseline.jobId} ${baseline.name}`}
            <IconButton name="times" size="sm" tooltip="Clear baseline" onClick={onClearBaseline} />
          </span>
        )}
      </div>
      {editing && mode === 'filter' && (
        <div className={styles.editor}>
          <TimeRangeInput value={timeRange} onChange={onTimeRangeChange} clearable={false} />
          <JobFilters
            clusters={clusters}
            filters={filters}
            loadingClusters={loadingClusters}
            onChange={onFiltersChange}
            onSelectMetadata={selectMetadata}
            onSearch={() => onApplyFilter()}
            onOpenJob={(clusterId, jobId) => navigateToJobPage(clusterId, jobId)}
          />
        </div>
      )}
      {mode === 'filter' && total > COMPARE_JOB_LIMIT && (
        <Alert severity="info" title={`Showing ${COMPARE_JOB_LIMIT} of ${total} jobs. Narrow the filter to compare others.`} />
      )}
      {missingIds.length > 0 && <Alert severity="warning" title={`Couldn't load jobs: ${missingIds.join(', ')}`} />}
      {error && <Alert severity="error" title={error} />}
    </div>
  );
}
```

注: テストで `Showing 48 of 213` を出すとき `shownCount` は 45（GPU なしで 3 件非表示）。上限超過の判定は `total > COMPARE_JOB_LIMIT` で行い、`shownCount` には依存しない。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --testPathPatterns=JobCompare/JobSetBar.test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pages/JobCompare/JobSetBar.tsx src/pages/JobCompare/JobSetBar.test.tsx
git commit -m "feat: add job set bar for metric compare"
```

---

### Task 13: 系列取得フック

**Files:**
- Create: `src/pages/JobCompare/useCompareData.ts`
- Test: `src/pages/JobCompare/useCompareData.test.ts`

**Interfaces:**
- Consumes: `fetchCompareSeries`（Task 4）、`jobKey`、`JobSeries`（Task 2）、`PrometheusMetricType`
- Produces:
  - 型 `CompareDataState = { series: Map<string, JobSeries>; failedJobKeys: Set<string>; loading: boolean; now: number }`
  - `useCompareData(args: { jobs: JobRecord[]; cluster: ClusterSummary | null; metric: string; metricType: PrometheusMetricType }): CompareDataState & { retry: () => void }`
  - 取得のキーは「クラスタ・メトリクス・型・ジョブキー列・リトライ回数」。`metric` が空、`cluster` が null、ジョブ 0 件なら取得しない。古いリクエストの結果は捨てる。

- [ ] **Step 1: Write the failing test**

`src/pages/JobCompare/useCompareData.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --testPathPatterns=JobCompare/useCompareData.test`
Expected: FAIL（`Cannot find module './useCompareData'`）

- [ ] **Step 3: Write minimal implementation**

`src/pages/JobCompare/useCompareData.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { ClusterSummary, JobRecord } from '../../api/types';
import { PrometheusMetricType } from '../JobDashboard/scenes/metricDiscovery';
import { jobKey } from '../JobSearch/model';
import { fetchCompareSeries } from './metricQuery';
import { JobSeries } from './seriesTransform';

export interface CompareDataState {
  series: Map<string, JobSeries>;
  failedJobKeys: Set<string>;
  loading: boolean;
  now: number;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function useCompareData({
  jobs,
  cluster,
  metric,
  metricType,
}: {
  jobs: JobRecord[];
  cluster: ClusterSummary | null;
  metric: string;
  metricType: PrometheusMetricType;
}): CompareDataState & { retry: () => void } {
  const [state, setState] = useState<CompareDataState>(() => ({
    series: new Map(),
    failedJobKeys: new Set(),
    loading: false,
    now: nowSeconds(),
  }));
  const [attempt, setAttempt] = useState(0);
  const jobsRef = useRef(jobs);
  const jobsKey = jobs.map((job) => jobKey(job.clusterId, job.jobId)).join(',');

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  useEffect(() => {
    const targetJobs = jobsRef.current;
    if (!cluster || !metric || targetJobs.length === 0) {
      setState((current) => ({ ...current, series: new Map(), failedJobKeys: new Set(), loading: false }));
      return;
    }
    let cancelled = false;
    const now = nowSeconds();
    setState({ series: new Map(), failedJobKeys: new Set(), loading: true, now });
    fetchCompareSeries({ jobs: targetJobs, cluster, metricName: metric, metricType, now })
      .then((result) => {
        if (!cancelled) {
          setState({ series: result.series, failedJobKeys: result.failedJobKeys, loading: false, now });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({
            series: new Map(),
            failedJobKeys: new Set(targetJobs.map((job) => jobKey(job.clusterId, job.jobId))),
            loading: false,
            now,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cluster, metric, metricType, jobsKey, attempt]);

  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  return { ...state, retry };
}
```

注: `jobsRef` は描画中ではなく effect で更新する（`react-hooks` v7 の refs ルール対策、既存 `JobSearchPage` の `clustersRef` と同じ流儀）。effect は宣言順に実行されるため、取得 effect は常に最新の `jobs` を読む。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --testPathPatterns=JobCompare/useCompareData.test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pages/JobCompare/useCompareData.ts src/pages/JobCompare/useCompareData.test.ts
git commit -m "feat: add series loading hook for metric compare"
```

---

### Task 14: 拡大モーダル（per-GPU 表示）

**Files:**
- Create: `src/pages/JobCompare/JobDetailModal.tsx`
- Test: `src/pages/JobCompare/JobDetailModal.test.tsx`

**Interfaces:**
- Consumes: `buildMetricPreviewScene(job, cluster, entry, displayMode, selectedSeriesIds?): EmbeddedScene | null`（`JobDashboard/scenes/metricPanelsScene.ts`）、`buildCompareMetricEntry`（Task 5）、`buildJobRoute`
- Produces: `JobDetailModal(props: { job: JobRecord; cluster: ClusterSummary; metricName: string; metricType: PrometheusMetricType; onDismiss: () => void })`

- [ ] **Step 1: Write the failing test**

`src/pages/JobCompare/JobDetailModal.test.tsx`:

```tsx
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ClusterSummary, JobRecord } from '../../api/types';
import { buildMetricPreviewScene } from '../JobDashboard/scenes/metricPanelsScene';
import { JobDetailModal } from './JobDetailModal';

jest.mock('../JobDashboard/scenes/metricPanelsScene', () => ({
  buildMetricPreviewScene: jest.fn(),
}));

const mockedBuild = buildMetricPreviewScene as jest.MockedFunction<typeof buildMetricPreviewScene>;
const job = { clusterId: 'a100', jobId: 42, name: 'train' } as JobRecord;
const cluster = { id: 'a100' } as ClusterSummary;

describe('JobDetailModal', () => {
  beforeEach(() => mockedBuild.mockReset());

  it('renders the per-GPU preview scene and links to the job dashboard', () => {
    const Component = () => <div data-testid="preview-scene" />;
    mockedBuild.mockReturnValue({ Component } as unknown as ReturnType<typeof buildMetricPreviewScene>);
    const onDismiss = jest.fn();
    render(<JobDetailModal job={job} cluster={cluster} metricName="DCGM_FI_DEV_GPU_UTIL" metricType="gauge" onDismiss={onDismiss} />);
    expect(screen.getByText('#42 train · DCGM_FI_DEV_GPU_UTIL')).toBeInTheDocument();
    expect(screen.getByTestId('preview-scene')).toBeInTheDocument();
    expect(mockedBuild).toHaveBeenCalledWith(
      job,
      cluster,
      expect.objectContaining({ metricName: 'DCGM_FI_DEV_GPU_UTIL', legendFormat: '{{instance}} / GPU {{gpu}}' }),
      'raw'
    );
    expect(screen.getByRole('link', { name: /Open job dashboard/ })).toHaveAttribute('href', '/a/yuuki-slurm-app/jobs/a100/42');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('explains when no preview can be built', () => {
    mockedBuild.mockReturnValue(null);
    render(<JobDetailModal job={job} cluster={cluster} metricName="up" metricType="gauge" onDismiss={jest.fn()} />);
    expect(screen.getByText('No query is available for this metric.')).toBeInTheDocument();
  });
});
```

注: Grafana の `Modal` はヘッダに aria-label `Close` の IconButton を持つため、フッターのボタン文言は `Done` にして名前の衝突を避ける。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --testPathPatterns=JobCompare/JobDetailModal.test`
Expected: FAIL（`Cannot find module './JobDetailModal'`）

- [ ] **Step 3: Write minimal implementation**

`src/pages/JobCompare/JobDetailModal.tsx`:

```tsx
import React, { useMemo } from 'react';
import { Button, LinkButton, Modal } from '@grafana/ui';
import { ClusterSummary, JobRecord } from '../../api/types';
import { buildJobRoute } from '../../constants';
import { PrometheusMetricType } from '../JobDashboard/scenes/metricDiscovery';
import { buildMetricPreviewScene } from '../JobDashboard/scenes/metricPanelsScene';
import { buildCompareMetricEntry } from './metricCatalog';

interface Props {
  job: JobRecord;
  cluster: ClusterSummary;
  metricName: string;
  metricType: PrometheusMetricType;
  onDismiss: () => void;
}

export function JobDetailModal({ job, cluster, metricName, metricType, onDismiss }: Props) {
  const scene = useMemo(
    () => buildMetricPreviewScene(job, cluster, buildCompareMetricEntry(metricName, metricType), 'raw'),
    [job, cluster, metricName, metricType]
  );

  return (
    <Modal title={`#${job.jobId} ${job.name} · ${metricName}`} isOpen onDismiss={onDismiss}>
      {scene ? <scene.Component model={scene} /> : <div>No query is available for this metric.</div>}
      <Modal.ButtonRow>
        <LinkButton href={buildJobRoute(job.clusterId, job.jobId)} variant="secondary" icon="external-link-alt">
          Open job dashboard
        </LinkButton>
        <Button variant="primary" onClick={onDismiss}>
          Done
        </Button>
      </Modal.ButtonRow>
    </Modal>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --testPathPatterns=JobCompare/JobDetailModal.test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pages/JobCompare/JobDetailModal.tsx src/pages/JobCompare/JobDetailModal.test.tsx
git commit -m "feat: add per-GPU detail modal for metric compare"
```

---

### Task 15: ページ本体・ルーティング・ナビ

**Files:**
- Create: `src/pages/JobCompare/JobComparePage.tsx`
- Test: `src/pages/JobCompare/JobComparePage.test.tsx`
- Modify: `src/components/App/App.tsx`
- Modify: `src/plugin.json`

**Interfaces:**
- Consumes: Task 1〜14 のすべて。加えて `listClusters`, `getJob`（`slurmApi`）、`getNextClusterId`, `SearchFilters`、`navigateToJobPage`、`resolveTimelineRange`, `timelineRangeToRawValues`、`loadCompareViewPreferences`, `saveCompareViewPreferences`
- Produces: `JobComparePage()`（props なし、URL から状態を読む）、ルート `/a/yuuki-slurm-app/compare`

- [ ] **Step 1: Write the failing test**

`src/pages/JobCompare/JobComparePage.test.tsx`:

```tsx
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { getJob, listClusters, listJobs } from '../../api/slurmApi';
import { JobRecord } from '../../api/types';
import { fetchMetricTypes, listMetricNames } from './metricCatalog';
import { fetchCompareSeries } from './metricQuery';
import { JobComparePage } from './JobComparePage';

jest.mock('../../api/slurmApi', () => ({
  listClusters: jest.fn(),
  listJobs: jest.fn(),
  getJob: jest.fn(),
  listJobMetadataOptions: jest.fn().mockResolvedValue({ values: [] }),
}));

jest.mock('./metricCatalog', () => ({
  ...jest.requireActual('./metricCatalog'),
  listMetricNames: jest.fn(),
  fetchMetricTypes: jest.fn(),
}));

jest.mock('./metricQuery', () => ({
  ...jest.requireActual('./metricQuery'),
  fetchCompareSeries: jest.fn(),
}));

jest.mock('../../storage/userPreferences', () => ({
  loadCompareViewPreferences: jest.fn(() => ({})),
  saveCompareViewPreferences: jest.fn(),
}));

jest.mock('../JobSearch/navigation', () => ({
  navigateToJobPage: jest.fn(),
}));

jest.mock('./JobDetailModal', () => ({
  JobDetailModal: () => <div data-testid="job-detail-modal" />,
}));

jest.mock('@grafana/ui', () => {
  const actual = jest.requireActual('@grafana/ui');
  return { ...actual, TimeRangeInput: () => <div data-testid="time-range-input" /> };
});

const mockedListClusters = listClusters as jest.MockedFunction<typeof listClusters>;
const mockedListJobs = listJobs as jest.MockedFunction<typeof listJobs>;
const mockedGetJob = getJob as jest.MockedFunction<typeof getJob>;
const mockedListMetricNames = listMetricNames as jest.MockedFunction<typeof listMetricNames>;
const mockedFetchMetricTypes = fetchMetricTypes as jest.MockedFunction<typeof fetchMetricTypes>;
const mockedFetchCompareSeries = fetchCompareSeries as jest.MockedFunction<typeof fetchCompareSeries>;

const cluster = {
  id: 'a100',
  displayName: 'A100',
  slurmClusterName: 'slurm-a100',
  metricsDatasourceUid: 'prom',
  metricsType: 'prometheus' as const,
  aggregationNodeLabels: ['instance'],
  instanceLabel: 'instance',
  nodeMatcherMode: 'hostname' as const,
  defaultTemplateId: 'overview',
  metricsFilterLabel: '',
  metricsFilterValue: '',
};

function makeJob(jobId: number): JobRecord {
  return {
    clusterId: 'a100',
    jobId,
    name: `train-${jobId}`,
    user: 'alice',
    account: 'ml',
    partition: 'gpu',
    state: 'COMPLETED',
    nodes: [`n${jobId}`],
    nodeList: `n${jobId}`,
    nodeCount: 1,
    gpusTotal: 8,
    submitTime: 1000,
    startTime: 1000,
    endTime: 4600,
    exitCode: 0,
    workDir: '/tmp',
    tres: '',
    templateId: 'overview',
  };
}

function seriesFor(jobIds: number[]) {
  return new Map(
    jobIds.map((id) => [`a100-${id}`, { times: [1000, 2800, 4600], mean: [id, id, id], min: [id, id, id], max: [id, id, id] }])
  );
}

function setURL(query: string) {
  window.history.replaceState(null, '', `/a/yuuki-slurm-app/compare${query}`);
}

describe('JobComparePage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedListClusters.mockResolvedValue({ clusters: [cluster] });
    mockedListMetricNames.mockResolvedValue(['DCGM_FI_DEV_GPU_UTIL', 'node_load1']);
    mockedFetchMetricTypes.mockResolvedValue(new Map([['DCGM_FI_DEV_GPU_UTIL', 'gauge']]));
    mockedListJobs.mockResolvedValue({ jobs: [makeJob(1), makeJob(2)], total: 2 });
    mockedFetchCompareSeries.mockResolvedValue({ series: seriesFor([1, 2]), failedJobKeys: new Set() });
  });

  it('asks for a metric before querying series', async () => {
    setURL('?cluster=a100');
    render(<JobComparePage />);
    expect(await screen.findByText('Pick a metric to compare')).toBeInTheDocument();
    expect(mockedFetchCompareSeries).not.toHaveBeenCalled();
  });

  it('loads up to 48 filtered jobs and renders one cell per job', async () => {
    setURL('?cluster=a100&user=alice&metric=DCGM_FI_DEV_GPU_UTIL');
    render(<JobComparePage />);
    expect(await screen.findByRole('group', { name: 'Job 1' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Job 2' })).toBeInTheDocument();
    expect(mockedListJobs).toHaveBeenCalledWith(expect.objectContaining({ clusterId: 'a100', user: 'alice', limit: 48 }));
    expect(mockedFetchCompareSeries).toHaveBeenCalledWith(
      expect.objectContaining({ metricName: 'DCGM_FI_DEV_GPU_UTIL', metricType: 'gauge' })
    );
    await waitFor(() => expect(window.location.search).toContain('metric=DCGM_FI_DEV_GPU_UTIL'));
  });

  it('loads picked jobs by id in pick mode', async () => {
    mockedGetJob.mockImplementation(async (_cluster, id) => makeJob(Number(id)));
    setURL('?cluster=a100&mode=pick&jobs=1,2&metric=node_load1');
    render(<JobComparePage />);
    expect(await screen.findByRole('group', { name: 'Job 2' })).toBeInTheDocument();
    expect(mockedGetJob).toHaveBeenCalledTimes(2);
    expect(mockedListJobs).not.toHaveBeenCalled();
    expect(screen.getByText('2 picked jobs')).toBeInTheDocument();
  });

  it('reports failed jobs and retries', async () => {
    mockedFetchCompareSeries.mockResolvedValueOnce({ series: seriesFor([1]), failedJobKeys: new Set(['a100-2']) });
    setURL('?cluster=a100&metric=node_load1');
    render(<JobComparePage />);
    expect(await screen.findByText('1 of 2 jobs failed to load')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(mockedFetchCompareSeries).toHaveBeenCalledTimes(2));
  });

  it('switches to overlay layout', async () => {
    setURL('?cluster=a100&metric=node_load1');
    render(<JobComparePage />);
    await screen.findByRole('group', { name: 'Job 1' });
    fireEvent.click(screen.getByRole('radio', { name: 'Overlay' }));
    expect(await screen.findByRole('img', { name: 'Overlay of job series' })).toBeInTheDocument();
  });

  it('opens the detail modal from a cell', async () => {
    setURL('?cluster=a100&metric=node_load1');
    render(<JobComparePage />);
    const cell = await screen.findByRole('group', { name: 'Job 1' });
    fireEvent.click(cell.querySelector('svg[role="img"]')!);
    expect(screen.getByTestId('job-detail-modal')).toBeInTheDocument();
  });

  it('explains a missing metrics datasource', async () => {
    mockedListClusters.mockResolvedValue({ clusters: [{ ...cluster, metricsDatasourceUid: '' }] });
    setURL('?cluster=a100&metric=node_load1');
    render(<JobComparePage />);
    expect(await screen.findByText('This cluster has no metrics datasource')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --testPathPatterns=JobCompare/JobComparePage.test`
Expected: FAIL（`Cannot find module './JobComparePage'`）

- [ ] **Step 3: Write minimal implementation**

`src/pages/JobCompare/JobComparePage.tsx`:

```tsx
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2, TimeRange } from '@grafana/data';
import { Alert, Button, LoadingPlaceholder, useStyles2 } from '@grafana/ui';
import { getJob, listClusters } from '../../api/slurmApi';
import { ClusterSummary, JobRecord } from '../../api/types';
import { PLUGIN_ID } from '../../constants';
import { loadCompareViewPreferences, saveCompareViewPreferences } from '../../storage/userPreferences';
import { PrometheusMetricType } from '../JobDashboard/scenes/metricDiscovery';
import { getNextClusterId, SearchFilters } from '../JobSearch/model';
import { navigateToJobPage } from '../JobSearch/navigation';
import { resolveTimelineRange, timelineRangeToRawValues } from '../JobSearch/timelineRange';
import { CompareGrid } from './CompareGrid';
import { CompareOverlay } from './CompareOverlay';
import { CompareToolbar } from './CompareToolbar';
import { buildCompareView, CompareCellModel } from './compareView';
import { JobDetailModal } from './JobDetailModal';
import { finalizeJobSet, loadCompareTimeRange, loadFilterJobSet, loadPickedJobs } from './jobSet';
import { JobSetBar } from './JobSetBar';
import { fetchMetricTypes, listMetricNames, resolveMetricType } from './metricCatalog';
import { MetricPicker } from './MetricPicker';
import {
  buildCompareURLParams,
  CompareViewState,
  DEFAULT_VIEW_STATE,
  filtersFromCompareURLParams,
  toggleJobSelection,
  viewStateFromURLParams,
} from './model';
import { useCompareData } from './useCompareData';

interface JobSetState {
  jobs: JobRecord[];
  total: number;
  missingIds: string[];
  loading: boolean;
  error: string | null;
}

interface AppliedQuery {
  filters: SearchFilters;
  timeRange: TimeRange;
}

const EMPTY_JOB_SET: JobSetState = { jobs: [], total: 0, missingIds: [], loading: false, error: null };

function getStyles(theme: GrafanaTheme2) {
  return {
    page: css({ padding: theme.spacing(0, 2, 2, 2) }),
    empty: css({ padding: theme.spacing(4), textAlign: 'center', color: theme.colors.text.secondary }),
  };
}

export function JobComparePage() {
  const styles = useStyles2(getStyles);
  const [initialParams] = useState(() => new URLSearchParams(window.location.search));
  const [view, setView] = useState<CompareViewState>(() => ({
    ...DEFAULT_VIEW_STATE,
    ...loadCompareViewPreferences(),
    ...viewStateFromURLParams(initialParams),
  }));
  const [filters, setFilters] = useState<SearchFilters>(() => ({
    clusterId: '',
    ...filtersFromCompareURLParams(initialParams),
  }));
  const [timeRange, setTimeRange] = useState<TimeRange>(() => loadCompareTimeRange(initialParams));
  const [applied, setApplied] = useState<AppliedQuery>(() => ({ filters, timeRange }));
  const [clusters, setClusters] = useState<ClusterSummary[]>([]);
  const [loadingClusters, setLoadingClusters] = useState(true);
  const [clusterError, setClusterError] = useState<string | null>(null);
  const [jobSet, setJobSet] = useState<JobSetState>(EMPTY_JOB_SET);
  const [baselineJob, setBaselineJob] = useState<JobRecord | null>(null);
  const [metricNames, setMetricNames] = useState<string[]>([]);
  const [metricTypes, setMetricTypes] = useState<Map<string, PrometheusMetricType>>(() => new Map());
  const [loadingMetrics, setLoadingMetrics] = useState(false);
  const [detailCell, setDetailCell] = useState<CompareCellModel | null>(null);

  const cluster = clusters.find((c) => c.id === applied.filters.clusterId) ?? null;
  const patchView = useCallback((patch: Partial<CompareViewState>) => setView((current) => ({ ...current, ...patch })), []);

  useEffect(() => {
    let cancelled = false;
    listClusters()
      .then((response) => {
        if (cancelled) {
          return;
        }
        setClusters(response.clusters);
        const resolve = (current: SearchFilters) => {
          const clusterId = getNextClusterId(response.clusters, current.clusterId);
          return clusterId === current.clusterId ? current : { ...current, clusterId };
        };
        setFilters(resolve);
        setApplied((current) => ({ ...current, filters: resolve(current.filters) }));
      })
      .catch((e) => {
        if (!cancelled) {
          setClusterError(e instanceof Error ? e.message : 'Failed to load clusters');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingClusters(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pickedKey = view.pickedJobIds.join(',');
  useEffect(() => {
    if (loadingClusters || !applied.filters.clusterId) {
      return;
    }
    let cancelled = false;
    setJobSet((current) => ({ ...current, loading: true, error: null }));
    const pickedIds = pickedKey ? pickedKey.split(',') : [];
    const load =
      view.jobSetMode === 'pick'
        ? loadPickedJobs(applied.filters.clusterId, pickedIds).then((r) => ({ jobs: r.jobs, total: r.jobs.length, missingIds: r.missingIds }))
        : loadFilterJobSet(applied.filters, resolveTimelineRange(applied.timeRange)).then((r) => ({ ...r, missingIds: [] }));
    load
      .then((result) => {
        if (!cancelled) {
          setJobSet({ ...result, loading: false, error: null });
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setJobSet({ ...EMPTY_JOB_SET, error: e instanceof Error ? e.message : 'Failed to load jobs' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [applied, loadingClusters, view.jobSetMode, pickedKey]);

  useEffect(() => {
    const id = view.baselineJobId;
    const clusterId = applied.filters.clusterId;
    if (!id || !clusterId) {
      setBaselineJob(null);
      return;
    }
    const inSet = jobSet.jobs.find((job) => String(job.jobId) === id);
    if (inSet) {
      setBaselineJob(inSet);
      return;
    }
    let cancelled = false;
    getJob(clusterId, id)
      .then((job) => !cancelled && setBaselineJob(job))
      .catch(() => !cancelled && setBaselineJob(null));
    return () => {
      cancelled = true;
    };
  }, [view.baselineJobId, applied.filters.clusterId, jobSet.jobs]);

  useEffect(() => {
    if (!cluster) {
      return;
    }
    let cancelled = false;
    setLoadingMetrics(true);
    Promise.all([
      listMetricNames(cluster, resolveTimelineRange(applied.timeRange)).catch(() => [] as string[]),
      fetchMetricTypes(cluster),
    ])
      .then(([names, types]) => {
        if (!cancelled) {
          setMetricNames(names);
          setMetricTypes(types);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingMetrics(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cluster, applied.timeRange]);

  useEffect(() => {
    const params = buildCompareURLParams(view, applied.filters, timelineRangeToRawValues(applied.timeRange));
    const url = `${window.location.pathname}?${params.toString()}`;
    if (url !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(window.history.state, '', url);
    }
    saveCompareViewPreferences(view);
  }, [view, applied]);

  const metricType = view.metric ? resolveMetricType(view.metric, metricTypes) : 'unknown';
  const displayed = useMemo(
    () => finalizeJobSet(jobSet.jobs, { metric: view.metric, baseline: baselineJob }),
    [jobSet.jobs, view.metric, baselineJob]
  );
  // Wait for metadata so a counter is not first queried as a gauge.
  const data = useCompareData({
    jobs: displayed.jobs,
    cluster,
    metric: loadingMetrics ? '' : view.metric,
    metricType,
  });
  const model = useMemo(
    () =>
      buildCompareView({
        jobs: displayed.jobs,
        series: data.series,
        failedJobKeys: data.failedJobKeys,
        loading: data.loading || loadingMetrics,
        view,
        now: data.now,
      }),
    [displayed.jobs, data.series, data.failedJobKeys, data.loading, data.now, loadingMetrics, view]
  );

  const applyFilter = useCallback(
    (next?: SearchFilters) => {
      const nextFilters = next ?? filters;
      setFilters(nextFilters);
      setApplied({ filters: nextFilters, timeRange });
      patchView({ jobSetMode: 'filter', pickedJobIds: [], selectedJobIds: [] });
    },
    [filters, timeRange, patchView]
  );

  const changeTimeRange = useCallback(
    (range: TimeRange) => {
      setTimeRange(range);
      setApplied((current) => ({ ...current, timeRange: range }));
    },
    []
  );

  const cellActions = {
    onOpen: (cell: CompareCellModel) => setDetailCell(cell),
    onToggleSelect: (cell: CompareCellModel) =>
      setView((current) => ({ ...current, selectedJobIds: toggleJobSelection(current.selectedJobIds, String(cell.job.jobId)) })),
    onSetBaseline: (cell: CompareCellModel) => patchView({ baselineJobId: cell.isBaseline ? '' : String(cell.job.jobId) }),
    onOpenDashboard: (cell: CompareCellModel) => navigateToJobPage(cell.job.clusterId, cell.job.jobId),
  };

  const failedCount = model.cells.filter((cell) => cell.status === 'error').length;

  const renderBody = () => {
    if (cluster && !cluster.metricsDatasourceUid) {
      return (
        <Alert severity="info" title="This cluster has no metrics datasource">
          Set a Prometheus or VictoriaMetrics datasource for this cluster in the{' '}
          <a href={`/plugins/${PLUGIN_ID}`}>plugin configuration</a>.
        </Alert>
      );
    }
    if (!view.metric) {
      return (
        <div className={styles.empty}>
          <h3>Pick a metric to compare</h3>
          <p>Choose a metric above to draw one series per job.</p>
        </div>
      );
    }
    if (jobSet.loading && displayed.jobs.length === 0) {
      return <LoadingPlaceholder text="Loading jobs..." />;
    }
    if (displayed.jobs.length === 0) {
      return <div className={styles.empty}>No jobs match this filter.</div>;
    }
    return (
      <>
        {failedCount > 0 && (
          <Alert severity="warning" title={`${failedCount} of ${displayed.jobs.length} jobs failed to load`}>
            <Button size="sm" variant="secondary" onClick={data.retry}>
              Retry
            </Button>
          </Alert>
        )}
        {view.layout === 'overlay' ? (
          <CompareOverlay model={model} state={view} />
        ) : (
          <CompareGrid model={model} state={view} {...cellActions} />
        )}
      </>
    );
  };

  return (
    <div className={styles.page}>
      {clusterError && <Alert severity="error" title={clusterError} />}
      {loadingClusters ? (
        <LoadingPlaceholder text="Loading clusters..." />
      ) : (
        <>
          <MetricPicker
            names={metricNames}
            loading={loadingMetrics}
            value={view.metric}
            metricType={view.metric ? metricType : null}
            onChange={(metric) => patchView({ metric, selectedJobIds: [] })}
          />
          <JobSetBar
            clusters={clusters}
            loadingClusters={loadingClusters}
            mode={view.jobSetMode}
            filters={filters}
            appliedFilters={applied.filters}
            timeRange={timeRange}
            loading={jobSet.loading}
            error={jobSet.error}
            shownCount={displayed.jobs.length}
            total={jobSet.total}
            hiddenNonGpu={displayed.hiddenNonGpu}
            missingIds={jobSet.missingIds}
            baseline={baselineJob}
            onFiltersChange={setFilters}
            onApplyFilter={applyFilter}
            onTimeRangeChange={changeTimeRange}
            onSwitchToFilter={() => applyFilter()}
            onClearBaseline={() => patchView({ baselineJobId: '' })}
          />
          <CompareToolbar
            state={view}
            onChange={patchView}
            selectedCount={view.selectedJobIds.length}
            onOverlaySelected={() => patchView({ layout: 'overlay' })}
            onClearSelection={() => patchView({ selectedJobIds: [] })}
          />
          {renderBody()}
        </>
      )}
      {detailCell && cluster && (
        <JobDetailModal
          job={detailCell.job}
          cluster={cluster}
          metricName={view.metric}
          metricType={metricType}
          onDismiss={() => setDetailCell(null)}
        />
      )}
    </div>
  );
}
```

`src/components/App/App.tsx` に import と分岐を追加（Node Health の分岐の直前）:

```tsx
import { JobComparePage } from '../../pages/JobCompare/JobComparePage';
```

```tsx
  const pathname = window.location.pathname.replace(/\/+$/, '');

  if (new RegExp(`^/a/${PLUGIN_ID}/compare$`).test(pathname)) {
    return <JobComparePage />;
  }
```

（既存の `window.location.pathname.replace(/\/+$/, '')` の 2 回の呼び出しもこの `pathname` 変数に置き換える。）

`src/plugin.json` の `includes` で `Job Search` の直後に追加:

```json
    {
      "type": "page",
      "name": "Metric Compare",
      "path": "/a/yuuki-slurm-app/compare",
      "addToNav": true,
      "icon": "chart-line"
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --testPathPatterns=JobCompare && npm run typecheck`
Expected: PASS（JobCompare 配下の全テスト）

- [ ] **Step 5: Commit**

```bash
git add src/pages/JobCompare/JobComparePage.tsx src/pages/JobCompare/JobComparePage.test.tsx src/components/App/App.tsx src/plugin.json
git commit -m "feat: add metric compare page and navigation"
```

---

### Task 16: Job Search からの入口（行選択と Compare metric ボタン）

**Files:**
- Modify: `src/pages/JobSearch/navigation.ts`
- Modify: `src/pages/JobSearch/JobTable.tsx`
- Modify: `src/pages/JobSearch/JobSearchPage.tsx`
- Test: `src/pages/JobSearch/JobTable.test.tsx`（テスト追加）
- Test: `src/pages/JobSearch/JobSearchPage.test.tsx`（モック更新とテスト追加）

**Interfaces:**
- Consumes: `buildCompareRoute`（Task 1）、`buildCompareFromSearchParams`, `COMPARE_JOB_LIMIT`（Task 1）、`timelineRangeToRawValues`、`jobKey`
- Produces:
  - `navigation.ts`: `navigateToComparePage(params: URLSearchParams): void`
  - `JobTable` の追加 props: `selectedKeys?: Set<string>`, `onToggleSelect?: (job: JobRecord) => void`。チェックボックスの aria-label は `Select job <jobId>`。

- [ ] **Step 1: Write the failing tests**

`src/pages/JobSearch/JobTable.test.tsx` の `describe('JobTable', ...)` 内に追加:

```tsx
  it('toggles selection without opening the job', () => {
    const onToggleSelect = jest.fn();
    const onOpenJob = jest.fn();
    render(
      <JobTable
        jobs={jobs}
        loading={false}
        hasMore={false}
        loadingMore={false}
        loadedCount={1}
        totalCount={1}
        pageSize={100}
        selectedKeys={new Set(['a100-10001'])}
        onToggleSelect={onToggleSelect}
        onLoadMore={jest.fn()}
        onOpenJob={onOpenJob}
      />
    );
    const checkbox = screen.getByRole('checkbox', { name: 'Select job 10001' });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    expect(onToggleSelect).toHaveBeenCalledWith(jobs[0]);
    expect(onOpenJob).not.toHaveBeenCalled();
  });

  it('renders no selection column without a selection handler', () => {
    render(
      <JobTable
        jobs={jobs}
        loading={false}
        hasMore={false}
        loadingMore={false}
        loadedCount={1}
        totalCount={1}
        pageSize={100}
        onLoadMore={jest.fn()}
        onOpenJob={jest.fn()}
      />
    );
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
```

`src/pages/JobSearch/JobSearchPage.test.tsx`:

1. `import { navigateToJobPage, navigateToLinkedDashboard } from './navigation';` を `import { navigateToComparePage, navigateToJobPage, navigateToLinkedDashboard } from './navigation';` に変更。
2. `jest.mock('./navigation', ...)` のファクトリに `navigateToComparePage: jest.fn(),` を追加。
3. 既存の `mockedNavigateToLinkedDashboard` 定義の直後に追加:

```tsx
const mockedNavigateToComparePage = navigateToComparePage as jest.MockedFunction<typeof navigateToComparePage>;
```

4. 既存の `beforeEach` の末尾に `mockedNavigateToComparePage.mockReset();` を追加。
5. `describe('JobSearchPage', ...)` 内に追加:

```tsx
  it('opens metric compare for the selected jobs', async () => {
    mockedListClusters.mockResolvedValue({ clusters: [makeTestCluster()] });
    mockedListJobs.mockResolvedValue({ jobs: [makeTestJob(10001, 0), makeTestJob(10002, 1)], total: 2 });
    render(<JobSearchPage />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select job 10002' }));
    fireEvent.click(screen.getByRole('button', { name: 'Compare metric (1)' }));
    const params = mockedNavigateToComparePage.mock.calls[0][0];
    expect(params.get('cluster')).toBe('a100');
    expect(params.get('mode')).toBe('pick');
    expect(params.get('jobs')).toBe('10002');
  });

  it('opens metric compare with the current filter when nothing is selected', async () => {
    mockedListClusters.mockResolvedValue({ clusters: [makeTestCluster()] });
    mockedListJobs.mockResolvedValue({ jobs: [makeTestJob(10001, 0)], total: 1 });
    render(<JobSearchPage />);
    await screen.findByRole('checkbox', { name: 'Select job 10001' });
    fireEvent.click(screen.getByRole('button', { name: 'Compare metric' }));
    const params = mockedNavigateToComparePage.mock.calls[0][0];
    expect(params.get('mode')).toBeNull();
    expect(params.get('cluster')).toBe('a100');
    expect(params.get('from')).toBe('2023-11-14T22:00:00.000Z');
  });

  it('does not compare more than 48 selected jobs', async () => {
    mockedListClusters.mockResolvedValue({ clusters: [makeTestCluster()] });
    const jobs = Array.from({ length: 49 }, (_, i) => makeTestJob(20000 + i, i));
    mockedListJobs.mockResolvedValue({ jobs, total: 49 });
    render(<JobSearchPage />);
    await screen.findByRole('checkbox', { name: 'Select job 20000' });
    for (const checkbox of screen.getAllByRole('checkbox', { name: /^Select job / })) {
      fireEvent.click(checkbox);
    }
    expect(screen.getByText('Select up to 48 jobs to compare.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Compare metric (49)' }));
    expect(mockedNavigateToComparePage).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest --testPathPatterns="JobSearch/(JobTable|JobSearchPage).test"`
Expected: FAIL（チェックボックスとボタンが存在しない）

- [ ] **Step 3: Write minimal implementation**

`src/pages/JobSearch/navigation.ts`:

```ts
import { buildCompareRoute, buildJobRoute } from '../../constants';

export function navigateToJobPage(clusterId: string, jobId: number | string) {
  window.location.assign(buildJobRoute(clusterId, jobId));
}

export function navigateToLinkedDashboard(url: string) {
  window.location.assign(url);
}

export function navigateToComparePage(params: URLSearchParams) {
  window.location.assign(buildCompareRoute(params));
}
```

`src/pages/JobSearch/JobTable.tsx`:

- import に `Checkbox` を追加: `import { Badge, Button, Checkbox, LoadingPlaceholder, useStyles2 } from '@grafana/ui';`
- `Props` に追加:

```ts
  selectedKeys?: Set<string>;
  onToggleSelect?: (job: JobRecord) => void;
```

- 関数シグネチャの分割代入に `selectedKeys, onToggleSelect` を追加。
- `<thead><tr>` の先頭（`Job ID` の `th` の前）に追加:

```tsx
            {onToggleSelect && <th className={styles.th} aria-label="Select" />}
```

- 各行 `<tr ...>` の先頭（`{job.jobId}` の `td` の前）に追加:

```tsx
                {onToggleSelect && (
                  <td className={styles.td} onClick={(event) => event.stopPropagation()}>
                    <Checkbox
                      aria-label={`Select job ${job.jobId}`}
                      value={selectedKeys?.has(key) ?? false}
                      onChange={() => onToggleSelect(job)}
                    />
                  </td>
                )}
```

`src/pages/JobSearch/JobSearchPage.tsx`:

- import を変更・追加:

```tsx
import { Alert, Button, LoadingPlaceholder, useStyles2 } from '@grafana/ui';
import { buildCompareFromSearchParams, COMPARE_JOB_LIMIT } from '../JobCompare/model';
import { navigateToComparePage, navigateToJobPage, navigateToLinkedDashboard } from './navigation';
```

- `getStyles` に追加:

```ts
    compareBar: css({
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      margin: '8px 0',
    }),
```

- state を追加（`utilizationMap` の state の直後）:

```tsx
  const [selectedJobKeys, setSelectedJobKeys] = useState<Set<string>>(() => new Set());
```

- `fetchJobs` の非 append 分岐（`setUtilizationMap(new Map());` の直後）に追加:

```tsx
      setSelectedJobKeys(new Set());
```

- `loadMoreJobs` の定義の後に追加:

```tsx
  const toggleJobSelected = useCallback((job: JobRecord) => {
    setSelectedJobKeys((current) => {
      const next = new Set(current);
      const key = jobKey(job.clusterId, job.jobId);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const openCompare = useCallback(() => {
    if (selectedJobKeys.size > COMPARE_JOB_LIMIT) {
      return;
    }
    const selectedIds = jobs
      .filter((job) => selectedJobKeys.has(jobKey(job.clusterId, job.jobId)))
      .map((job) => String(job.jobId));
    navigateToComparePage(buildCompareFromSearchParams(filters, timelineRangeToRawValues(timelineTimeRange), selectedIds));
  }, [filters, jobs, selectedJobKeys, timelineTimeRange]);
```

- JSX の `<JobTimeline ... />` と `<JobTable ... />` の間に追加:

```tsx
          <div className={styles.compareBar}>
            <Button size="sm" variant="secondary" icon="chart-line" onClick={openCompare}>
              {selectedJobKeys.size > 0 ? `Compare metric (${selectedJobKeys.size})` : 'Compare metric'}
            </Button>
            {selectedJobKeys.size > COMPARE_JOB_LIMIT && (
              <span role="alert">{`Select up to ${COMPARE_JOB_LIMIT} jobs to compare.`}</span>
            )}
          </div>
```

- `<JobTable ... />` に props を追加:

```tsx
            selectedKeys={selectedJobKeys}
            onToggleSelect={toggleJobSelected}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest --testPathPatterns="JobSearch/" && npm run typecheck`
Expected: PASS（既存の JobSearch テストも含めて PASS）

- [ ] **Step 5: Commit**

```bash
git add src/pages/JobSearch/navigation.ts src/pages/JobSearch/JobTable.tsx src/pages/JobSearch/JobTable.test.tsx src/pages/JobSearch/JobSearchPage.tsx src/pages/JobSearch/JobSearchPage.test.tsx
git commit -m "feat: open metric compare from job search selection"
```

---

### Task 17: Job Dashboard からの入口（Compare across jobs）

**Files:**
- Modify: `src/pages/JobDashboard/components/MetricExplorer.tsx`
- Modify: `src/pages/JobDashboard/JobDashboardPage.tsx`
- Test: `src/pages/JobDashboard/components/MetricExplorer.test.tsx`（テスト追加）

**Interfaces:**
- Consumes: `buildCompareFromJobParams(job, metricName)`（Task 1）、`navigateToComparePage`（Task 16）、`parseMetricKey(metricKey): { kind: 'raw'; metricName: string } | null`（`metricDiscovery.ts`）
- Produces: `MetricExplorer` の追加 prop `onCompareAcrossJobs?: (metricKey: string) => void`（ボタンの tooltip / aria-label は `Compare across jobs`）

- [ ] **Step 1: Write the failing test**

`src/pages/JobDashboard/components/MetricExplorer.test.tsx` の `describe('MetricExplorer', ...)` 内に追加（既存の `entry()` ヘルパーを使う）:

```tsx
  it('offers comparing a metric across jobs when a handler is provided', () => {
    const onCompareAcrossJobs = jest.fn();
    render(
      <MetricExplorer
        rawEntries={[entry({ key: 'raw:DCGM_FI_DEV_GPU_UTIL', title: 'DCGM_FI_DEV_GPU_UTIL', metricName: 'DCGM_FI_DEV_GPU_UTIL' })]}
        selectedMetricKeys={[]}
        displayMode="aggregated"
        onDisplayModeChange={jest.fn()}
        onTogglePin={jest.fn()}
        onOpenInExplore={jest.fn()}
        onCompareAcrossJobs={onCompareAcrossJobs}
        renderPreview={(item) => <div data-testid={`preview-${item.key}`}>Preview {item.title}</div>}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Compare across jobs' }));
    expect(onCompareAcrossJobs).toHaveBeenCalledWith('raw:DCGM_FI_DEV_GPU_UTIL');
  });

  it('hides the compare button without a handler', () => {
    renderMetricExplorer([entry({ key: 'raw:node_load1', title: 'node_load1', metricName: 'node_load1' })]);
    expect(screen.queryByRole('button', { name: 'Compare across jobs' })).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --testPathPatterns=MetricExplorer.test`
Expected: FAIL（`Compare across jobs` ボタンが存在しない）

- [ ] **Step 3: Write minimal implementation**

`src/pages/JobDashboard/components/MetricExplorer.tsx`:

- `Props` に `onCompareAcrossJobs?: (metricKey: string) => void;` を追加し、関数の分割代入にも追加する。
- メトリクスカードのボタン群で、`Open in Explore` の `IconButton` の直前に追加:

```tsx
                  {onCompareAcrossJobs && (
                    <IconButton
                      name="chart-line"
                      size="md"
                      variant="secondary"
                      tooltip="Compare across jobs"
                      onClick={() => onCompareAcrossJobs(entry.key)}
                    />
                  )}
```

`src/pages/JobDashboard/JobDashboardPage.tsx`:

- import を追加:

```tsx
import { buildCompareFromJobParams } from '../JobCompare/model';
import { navigateToComparePage } from '../JobSearch/navigation';
```

  `parseMetricKey` が `./scenes/metricDiscovery` から未 import なら同じ import 文に追加する。
- `handleOpenInExplore` の定義の直後に追加:

```tsx
  const handleCompareAcrossJobs = (metricKey: string) => {
    if (!job) {
      return;
    }
    const parsed = parseMetricKey(metricKey);
    if (!parsed) {
      return;
    }
    navigateToComparePage(buildCompareFromJobParams(job, parsed.metricName));
  };
```

- `<MetricExplorer ... />` に `onCompareAcrossJobs={handleCompareAcrossJobs}` を追加（`onOpenInExplore` の直後）。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest --testPathPatterns="JobDashboard/" && npm run typecheck`
Expected: PASS（既存の `JobDashboardPage.test.tsx` も PASS。`./scenes/metricDiscovery` のモックは `requireActual` を展開しているので `parseMetricKey` はそのまま使える）

- [ ] **Step 5: Commit**

```bash
git add src/pages/JobDashboard/components/MetricExplorer.tsx src/pages/JobDashboard/components/MetricExplorer.test.tsx src/pages/JobDashboard/JobDashboardPage.tsx
git commit -m "feat: open metric compare from the job dashboard metric explorer"
```

---

### Task 18: ドキュメントと全体検証

**Files:**
- Create: `docs/metric-compare.md`
- Modify: `docs/overview.md`（ドキュメント一覧にリンク追加）
- Modify: `README.md`（Documentation と Features に追記）

**Interfaces:**
- Consumes: Task 1〜17 の完成した機能
- Produces: ユーザー向けドキュメント、全テスト・lint・typecheck の通過、ローカル Grafana での目視確認

- [ ] **Step 1: Write the user guide**

`docs/metric-compare.md`:

```markdown
# Metric Compare

Metric Compare draws one time series per job for a single metric, so you can compare runs side by side or scan many jobs quickly for the one that behaves differently.

## Opening the page

- **Navigation**: select **Metric Compare** in the plugin menu.
- **Job Search**: tick jobs in the table and click **Compare metric (n)** to compare exactly those jobs. With nothing ticked, the button opens Metric Compare with your current search filter.
- **Job Dashboard**: in Metric Explorer, click the **Compare across jobs** button on a metric card. Metric Compare opens with that metric, jobs with the same user and job name from the last 30 days, and the current job as the baseline.

## Choosing what to compare

- **Metric**: pick a metric from the list. Common GPU training metrics appear under **Suggested**. Counter metrics are shown as `rate(...[5m])`.
- **Jobs**: by default the page uses a search filter (the same filters as Job Search) over the last 7 days. Click **Edit filter** to change it. Up to 48 jobs are compared; when more jobs match, the newest 48 are shown and the page asks you to narrow the filter.
- Jobs without GPUs are hidden when the metric is a GPU (DCGM) metric.
- **Baseline**: click the anchor icon on a cell to overlay that job as a dashed line in every cell.

## View options

| Option | Choices | Notes |
|--------|---------|-------|
| Layout | Grid, Overlay | Overlay draws up to 10 jobs on one chart. Shift-click cells in grid view to choose them. |
| X axis | Elapsed, Progress, Absolute | Elapsed aligns job start times. Progress maps each job from 0% to 100% so jobs of different lengths line up. Absolute uses wall-clock time. |
| Elapsed range | Whole job, first 1h / 6h / 24h | Elapsed axis only. |
| Reduce | Mean + min/max band, Mean, Max, Min | How each job's nodes and GPUs collapse into one line. |
| Y | Shared, Independent | Shared keeps heights comparable across cells. |
| Sort | Deviation from median, Mean, Start time, Duration, Job ID | |
| Columns | Auto, 2, 3, 4, 6 | Grid only. |

Hovering a cell shows a cursor at the same position in every cell. Click a cell to open a per-GPU view of that job; the dialog links to the full job dashboard.

## Deviation from median

When sorting by deviation, each job is resampled onto 200 points along the current x axis (elapsed time is used when the axis is Absolute). The page builds a median profile across jobs, scores each job by its average absolute distance from that profile, and outlines jobs whose score exceeds the median score plus two median absolute deviations. Running jobs are left out on the Progress axis because their progress is not final.

## Limitations

- On clusters where several jobs share a node, a job's series can include other jobs' activity on that node.
- The page state is kept in the URL, so you can share a link to the exact view.
```

`docs/overview.md` のドキュメント一覧（Metric Explorer の行の直後）に追加:

```markdown
- [Metric Compare](./metric-compare.md) - Compare one metric across many jobs
```

`README.md`:

- `## Documentation` の一覧で Metric Explorer の行の直後に追加:

```markdown
- [Metric Compare](./docs/metric-compare.md) - Compare one metric's time series across up to 48 jobs
```

- `## Features` の `**Metric Explorer**` の行の直後に追加:

```markdown
- **Metric Compare**: Compare one metric across up to 48 jobs on elapsed, progress, or wall-clock axes, sorted by deviation from the median
```

`docs/overview.md` の一覧の書式が上記と異なる場合（表形式など）は、既存の書式に合わせる。

- [ ] **Step 2: Run the full verification suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: すべて成功。lint の warning（`react-hooks/exhaustive-deps`）が新規ファイルで出た場合は依存配列を修正する。

- [ ] **Step 3: Verify in the local Grafana**

`verify-grafana-ui` スキルの手順に従い、`docker compose up -d` と `npm run dev` の状態で以下を確認する:

1. サイドメニューに **Metric Compare** が Job Search の次に表示される。
2. Job Search で 2 ジョブにチェック → **Compare metric (2)** → Metric Compare が Pick モードで 2 セル表示される。
3. Metric に `DCGM_FI_DEV_GPU_UTIL` を選ぶとセルにスパークラインが描かれ、ホバーで全セルにカーソルが出る。
4. X axis を Progress に切り替えると軸注記が `X: 0% – 100%` になる。
5. Layout を Overlay にすると重ね描きと凡例テーブルが出る。
6. Job Dashboard の Metric Explorer で **Compare across jobs** → 同ユーザー・同名ジョブで開き、Baseline チップが表示される。
7. ページを再読み込みしても URL から同じ状態に戻る。

- [ ] **Step 4: Commit**

```bash
git add docs/metric-compare.md docs/overview.md README.md
git commit -m "docs: add metric compare user guide"
```

---

## Self-Review Notes

仕様（`docs/superpowers/specs/2026-10-07-job-metric-compare-design.md`）との対応:

| 仕様の要素 | タスク |
|-----------|--------|
| ルート・ナビ | Task 1（route）, Task 15（App / plugin.json） |
| 入口: Job Search / Job Dashboard / ナビ直接（前回状態） | Task 16 / Task 17 / Task 6（保存）+ Task 15（復元） |
| Metric picker（Suggested、型バッジ、counter の rate） | Task 5, Task 11, Task 4 |
| Job set（Filter 既定、Pick、48 上限と文言、GPU 除外） | Task 6, Task 12, Task 15 |
| Baseline（固定・全セルに点線） | Task 7, Task 9, Task 12, Task 15 |
| Layout / X axis（Elapsed・Progress・Absolute）/ Reduce / Y / Sort / Columns / Elapsed range | Task 7, Task 11 |
| URL 状態共有 | Task 1, Task 15 |
| Grid セル（状態色、要約統計、同期カーソル、乖離ハイライト、RUNNING 破線、異常終了 ×、no data、クリック拡大、Shift 選択） | Task 8, Task 9 |
| Progress 軸（再サンプリング、RUNNING 注記とスコア除外、進捗率と経過時間の併記） | Task 2, Task 7, Task 9 |
| Overlay（10 本上限と警告、凡例ホバー強調、Baseline 太線） | Task 10 |
| 拡大モーダル（per-GPU、Job Dashboard への導線） | Task 14 |
| ロード中スケルトン・部分失敗 Retry・データソース未設定 | Task 9, Task 13, Task 15 |
| 乖離スコア（中央値プロファイル、3 ジョブ未満の点を除外、中央値 + 2×MAD、差し替え可能な関数） | Task 3, Task 7 |
| 性能（ノード和集合でのバッチ、時間方向の分割、直列実行、step 計算、SVG 描画） | Task 4, Task 8 |
| ドキュメント | Task 18 |

仕様で Phase 1 対象外としたもの（ピン留めパネルのメニュー、ピン留めメトリクスの Suggested 取り込み、Edit PromQL、高度な統計手法）は計画に含めない。
