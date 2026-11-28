import { JobRecord } from '../../../api/types';
import {
  ALIGN_MIN_BUCKETS,
  bucketIndex,
  CPU_WINDOW_LEAD_SECONDS,
  CPU_WINDOW_SECONDS,
  cpuWindowIndex,
  estimateGpuSeries,
  MAX_BUCKETS,
  MIN_JOB_SECONDS,
  planCpuWindows,
  planScoreWindow,
  POINT_BUDGET,
  requiredCpuWindowLead,
  ScoredWindow,
} from './window';

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
      runningLagSeconds: 0,
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

  it('scores a running job up to two minutes ago, when the newest samples have arrived', () => {
    const window = scored(makeJob({ state: 'RUNNING', endTime: 0 }), START + 1800);
    expect(window).toMatchObject({ running: true, runningLagSeconds: 120, jobEnd: START + 1680, gridEnd: START + 1680, buckets: 28 });
  });

  it('shortens the lag of a running job rather than calling it too short', () => {
    const job = makeJob({ state: 'RUNNING', endTime: 0 });
    expect(planScoreWindow(job, START + 299)).toEqual({ status: 'too-short', elapsedSeconds: 299 });
    expect(scored(job, START + 300)).toMatchObject({ runningLagSeconds: 0, jobEnd: START + 300 });
    expect(scored(job, START + 360)).toMatchObject({ runningLagSeconds: 60, jobEnd: START + 300 });
    expect(scored(job, START + 420)).toMatchObject({ runningLagSeconds: 120, jobEnd: START + 300 });
    expect(scored(job, START + 480)).toMatchObject({ runningLagSeconds: 120, jobEnd: START + 360 });
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

  it('sizes the buckets for the GPU series a response showed, when they are more than estimated', () => {
    const job = makeJob({ nodes: ['a', 'b'], nodeCount: 2, gpusTotal: 2, endTime: START + 86400 });

    // Estimated: 8 GPUs per node, 16 series, 240 buckets.
    expect(scored(job)).toMatchObject({ step: 360 });
    expect(planScoreWindow(job, START + 100_000, 16)).toMatchObject({ step: 360 });
    // 500 series: 24000 / 500 = 48 buckets.
    const replanned = planScoreWindow(job, START + 100_000, 500);
    expect(replanned).toMatchObject({ status: 'ok', step: 1800 });
    expect(500 * (replanned as ScoredWindow).buckets).toBeLessThanOrEqual(POINT_BUDGET);
    expect(planScoreWindow(job, START + 100_000, POINT_BUDGET + 1)).toEqual({ status: 'too-large', estimatedGpus: POINT_BUDGET + 1 });
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

describe('planCpuWindows', () => {
  it('tiles a job with one-minute buckets with five-minute windows that begin after a lead', () => {
    // START is a multiple of 300 plus 240. The window that would end at
    // START + 360 would begin 60 s after the start: too early.
    const windows = planCpuWindows(scored(makeJob()));

    expect(windows).toMatchObject({ start: START + 360, step: 300, count: 10, seconds: 300 });
    expect(windows.coverage).toBeCloseTo(3000 / 3600);
    expect(windows.leadSeconds).toEqual([360, 660, 960, 1260, 1560, 1860, 2160, 2460, 2760, 3060]);
  });

  it('never starts a window sooner than the lead after the start of the job, whatever the start and the length of the job', () => {
    for (const offset of [0, 1, 37, 59, 137, 299]) {
      for (const duration of [300, 360, 374, 375, 420, 599, 600, 674, 675, 905, 3600, 5 * 3600, 26 * 3600, 9 * 86400]) {
        const window = scored(makeJob({ startTime: START + offset, endTime: START + offset + duration }));
        const windows = planCpuWindows(window);
        const firstWindowStart = windows.start + windows.step - windows.seconds;
        const lastWindowEnd = windows.start + windows.count * windows.step;

        expect(windows.step).toBeGreaterThanOrEqual(windows.seconds);
        expect(windows.leadSeconds).toHaveLength(windows.count);
        expect(windows.coverage).toBeLessThanOrEqual(1);
        if (windows.count === 0) {
          continue;
        }
        expect(firstWindowStart).toBeGreaterThanOrEqual(window.gridStart);
        expect(firstWindowStart - (START + offset)).toBeGreaterThanOrEqual(CPU_WINDOW_LEAD_SECONDS);
        expect(windows.leadSeconds[0]).toBe(firstWindowStart - (START + offset));
        expect(lastWindowEnd).toBeLessThanOrEqual(window.gridEnd);
      }
    }
  });

  it('counts the windows of a short job back from its end, and gives none to a job that is too short for the lead', () => {
    // Seven minutes: one window, which ends with the job and begins two minutes after its start.
    const sevenMinutes = scored(makeJob({ startTime: START + 37, endTime: START + 37 + 420 }));
    expect(planCpuWindows(sevenMinutes)).toMatchObject({ start: sevenMinutes.gridEnd - 300, step: 300, count: 1, leadSeconds: [120] });

    // 6 min 15 s is the shortest job with a window; six minutes leave only 60 s before one.
    expect(planCpuWindows(scored(makeJob({ endTime: START + 375 })))).toMatchObject({ count: 1, leadSeconds: [75] });
    expect(planCpuWindows(scored(makeJob({ endTime: START + 374 })))).toMatchObject({ count: 0, coverage: 0, leadSeconds: [] });
    expect(planCpuWindows(scored(makeJob({ endTime: START + 360 })))).toMatchObject({ count: 0 });

    // Twelve minutes: two windows fit behind the lead; eleven minutes hold one.
    expect(planCpuWindows(scored(makeJob({ endTime: START + 720 })))).toMatchObject({ count: 2, leadSeconds: [120, 420] });
    expect(planCpuWindows(scored(makeJob({ endTime: START + 660 })))).toMatchObject({ count: 1, leadSeconds: [360] });
  });

  it('samples one window at the end of each bucket when buckets are longer than five minutes', () => {
    const window = scored(makeJob({ endTime: START + 3 * 86400 }));
    const windows = planCpuWindows(window);

    expect(window.step).toBe(1080);
    expect(windows).toMatchObject({ start: window.gridStart, step: 1080, count: window.buckets, seconds: CPU_WINDOW_SECONDS });
    expect(windows.coverage).toBeCloseTo(300 / 1080);
    // The window ends are multiples of the step, like the bucket ends.
    expect(windows.start % windows.step).toBe(0);
    expect(windows.leadSeconds[0]).toBeGreaterThanOrEqual(CPU_WINDOW_LEAD_SECONDS);
  });

  it('maps evaluation times to windows and rejects the others', () => {
    const windows = planCpuWindows(scored(makeJob()));

    expect(cpuWindowIndex(windows, windows.start + 300)).toBe(0);
    expect(cpuWindowIndex(windows, windows.start + 10 * 300)).toBe(9);
    expect(cpuWindowIndex(windows, windows.start)).toBe(-1);
    expect(cpuWindowIndex(windows, windows.start + 11 * 300)).toBe(-1);
    expect(cpuWindowIndex(windows, windows.start + 450)).toBe(-1);
  });
});

describe('requiredCpuWindowLead', () => {
  it('bounds the scrape interval by the samples a window holds', () => {
    // n samples in 300 s are less than 300 / (n - 1) apart.
    expect(requiredCpuWindowLead(20, 300)).toBeCloseTo(300 / 19);
    expect(requiredCpuWindowLead(5, 300)).toBe(75);
    expect(requiredCpuWindowLead(4, 300)).toBe(100);
    expect(requiredCpuWindowLead(3, 300)).toBe(150);
    expect(requiredCpuWindowLead(2, 300)).toBe(300);
    // No rate without two samples.
    expect(requiredCpuWindowLead(1, 300)).toBe(Infinity);
    expect(requiredCpuWindowLead(0, 300)).toBe(Infinity);
    // The lead of the first window covers a scrape every 60 s: five samples in 300 s.
    expect(requiredCpuWindowLead(5, CPU_WINDOW_SECONDS)).toBeLessThanOrEqual(CPU_WINDOW_LEAD_SECONDS);
  });
});
