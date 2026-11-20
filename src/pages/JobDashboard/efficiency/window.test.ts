import { JobRecord } from '../../../api/types';
import { ALIGN_MIN_BUCKETS, bucketIndex, estimateGpuSeries, MAX_BUCKETS, MIN_JOB_SECONDS, planScoreWindow, POINT_BUDGET, ScoredWindow } from './window';

// A multiple of 60: a job that starts here starts on a one-minute boundary.
const START = 1_700_000_040;

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    clusterId: 'a100',
    jobId: 1,
    name: 'train',
    user: 'researcher1',
    account: 'ml-team',
    partition: 'gpu-a100',
    state: 'COMPLETED',
    nodes: ['gpu-node001'],
    nodeList: 'gpu-node001',
    nodeCount: 1,
    gpusTotal: 8,
    submitTime: START - 60,
    startTime: START,
    endTime: START + 3600,
    exitCode: 0,
    workDir: '/tmp',
    tres: '1=64,1001=8',
    templateId: 'overview',
    ...overrides,
  };
}

function scored(job: JobRecord, now = START + 100_000): ScoredWindow {
  const window = planScoreWindow(job, now);
  if (window.status !== 'ok') {
    throw new Error(`expected a scored window, got ${window.status}`);
  }
  return window;
}

describe('planScoreWindow', () => {
  it('gives a one hour job sixty one-minute buckets', () => {
    expect(scored(makeJob())).toEqual({
      status: 'ok',
      running: false,
      jobStart: START,
      jobEnd: START + 3600,
      gridStart: START,
      gridEnd: START + 3600,
      step: 60,
      buckets: 60,
      skippedStartSeconds: 0,
      skippedEndSeconds: 0,
    });
  });

  it('puts the bucket boundaries on multiples of the bucket length and reports the seconds it skips', () => {
    // The job starts 25 s and ends 50 s after a full minute.
    const window = scored(makeJob({ startTime: START + 25, endTime: START + 3650 }));

    expect(window).toMatchObject({
      step: 60,
      gridStart: START + 60,
      gridEnd: START + 3600,
      buckets: 59,
      skippedStartSeconds: 35,
      skippedEndSeconds: 50,
    });
    expect(window.gridStart % window.step).toBe(0);
    expect(window.gridEnd % window.step).toBe(0);
  });

  it('keeps every bucket inside the job for any start and end', () => {
    for (const [startOffset, length] of [
      [0, 600],
      [1, 600],
      [59, 601],
      [17, 3599],
      [43, 86400 * 3 + 7],
      [5, 86400 * 30],
    ]) {
      const job = makeJob({ startTime: START + startOffset, endTime: START + startOffset + length });
      const window = scored(job);
      expect(window.buckets).toBeGreaterThanOrEqual(1);
      expect(window.gridStart).toBeGreaterThanOrEqual(job.startTime);
      expect(window.gridEnd).toBeLessThanOrEqual(job.endTime);
      expect(window.gridStart + window.buckets * window.step).toBe(window.gridEnd);
      expect(window.skippedStartSeconds).toBeLessThan(window.step);
      expect(window.skippedEndSeconds).toBeLessThan(window.step);
      expect(window.skippedStartSeconds + window.buckets * window.step + window.skippedEndSeconds).toBe(length);
    }
  });

  it('does not align a window of few buckets, which would lose a large part of the job', () => {
    // Nine minutes that start 30 s after a full minute: nine buckets up to the job end.
    const window = scored(makeJob({ startTime: START + 30, endTime: START + 30 + (ALIGN_MIN_BUCKETS - 1) * 60 }));

    expect(window).toMatchObject({
      buckets: ALIGN_MIN_BUCKETS - 1,
      gridStart: START + 30,
      gridEnd: START + 30 + (ALIGN_MIN_BUCKETS - 1) * 60,
      skippedStartSeconds: 0,
      skippedEndSeconds: 0,
    });
  });

  it('scores a running job up to now', () => {
    const window = scored(makeJob({ state: 'RUNNING', endTime: 0 }), START + 1800);
    expect(window.running).toBe(true);
    expect(window.gridEnd).toBe(START + 1800);
    expect(window.buckets).toBe(30);
  });

  it('caps the bucket count for long jobs by making buckets longer', () => {
    const window = scored(makeJob({ endTime: START + 7 * 86400 }));
    expect(window.step).toBe(2520);
    // One bucket can be lost to the alignment.
    expect(window.buckets).toBeGreaterThanOrEqual(MAX_BUCKETS - 1);
    expect(window.buckets).toBeLessThanOrEqual(MAX_BUCKETS);
  });

  it('keeps GPUs x buckets under the point budget for large jobs', () => {
    const nodes = Array.from({ length: 250 }, (_, index) => `gpu-node${String(index + 1).padStart(3, '0')}`);
    const job = makeJob({ nodes, nodeCount: 250, gpusTotal: 2000, endTime: START + 7 * 86400 });
    const window = scored(job);
    expect(window.step).toBe(50400);
    expect(window.buckets).toBeGreaterThanOrEqual(11);
    expect(window.buckets).toBeLessThanOrEqual(12);
    expect(estimateGpuSeries(job) * window.buckets).toBeLessThanOrEqual(POINT_BUDGET);
  });

  it('sizes the response for whole nodes when the job allocates only some of their GPUs', () => {
    const job = makeJob({ gpusTotal: 1 });
    expect(estimateGpuSeries(job)).toBe(8);
  });

  it('falls back to a single bucket for the largest jobs it scores', () => {
    const nodes = Array.from({ length: 3000 }, (_, index) => `n${index}`);
    const window = scored(makeJob({ nodes, nodeCount: 3000, gpusTotal: 24000, endTime: START + 86400 }));
    expect(window.buckets).toBe(1);
    expect(window.step).toBe(86400);
  });

  it.each([
    ['a pending job', makeJob({ state: 'PENDING', startTime: 0, endTime: 0 }), { status: 'not-started' }],
    ['a job shorter than the minimum', makeJob({ endTime: START + MIN_JOB_SECONDS - 1 }), { status: 'too-short', elapsedSeconds: MIN_JOB_SECONDS - 1 }],
    ['a job that ends before it starts', makeJob({ endTime: START - 10 }), { status: 'too-short', elapsedSeconds: 0 }],
    ['more GPUs than the point budget', makeJob({ gpusTotal: POINT_BUDGET + 8 }), { status: 'too-large', estimatedGpus: POINT_BUDGET + 8 }],
    [
      'a node list that the backend could not expand',
      makeJob({ nodes: ['n[1-99999]'], nodeCount: 99999, gpusTotal: 8 }),
      { status: 'too-large', estimatedGpus: 99999 * 8 },
    ],
  ])('does not score %s', (_name, job, expected) => {
    expect(planScoreWindow(job, START + 100_000)).toEqual(expected);
  });

  it('scores a job of exactly the minimum length', () => {
    expect(scored(makeJob({ endTime: START + MIN_JOB_SECONDS })).buckets).toBe(5);
  });
});

describe('bucketIndex', () => {
  const window = scored(makeJob());

  it('maps evaluation times to buckets', () => {
    expect(bucketIndex(window, START + 60)).toBe(0);
    expect(bucketIndex(window, START + 3600)).toBe(59);
  });

  it('rejects times outside the window or off the grid', () => {
    expect(bucketIndex(window, START)).toBe(-1);
    expect(bucketIndex(window, START + 3660)).toBe(-1);
    expect(bucketIndex(window, START + 90)).toBe(-1);
  });
});
