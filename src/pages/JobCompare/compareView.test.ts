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
