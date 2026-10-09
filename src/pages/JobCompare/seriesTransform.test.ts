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
