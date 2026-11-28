import {
  FALLBACK_SCRAPE_SECONDS,
  MAX_BUCKETS,
  MAX_NODES,
  MIN_BUCKETS,
  niceStep,
  PhasePlan,
  PhaseWindow,
  planWindow,
  POINT_BUDGET,
  PROBE_RANGE_SECONDS,
  gpuProbeTimes,
  probeTime,
  runEnd,
  scrapeIntervalFromCounts,
} from './plan';

const NOW = 1_760_000_000;
const HOUR = 3600;

function windowOf(plan: PhasePlan): PhaseWindow {
  if (!('window' in plan)) {
    throw new Error(`expected a window, got refusal ${plan.refusal}`);
  }
  return plan.window;
}

describe('niceStep', () => {
  it('rounds up to the next usual step', () => {
    expect(niceStep(1)).toBe(60);
    expect(niceStep(60)).toBe(60);
    expect(niceStep(61)).toBe(120);
    expect(niceStep(250)).toBe(300);
    expect(niceStep(301)).toBe(600);
    expect(niceStep(86400)).toBe(86400);
    expect(niceStep(86401)).toBe(172800);
  });
});

describe('scrapeIntervalFromCounts', () => {
  it('takes the series with the most samples', () => {
    expect(scrapeIntervalFromCounts([40, 39, 12], 600)).toBe(15);
    expect(scrapeIntervalFromCounts([20], 600)).toBe(30);
    expect(scrapeIntervalFromCounts([9, 10], 600)).toBe(60);
    expect(scrapeIntervalFromCounts([2], 600)).toBe(300);
  });

  it('snaps to a common interval when a scrape was missed or one more fell into the range', () => {
    expect(scrapeIntervalFromCounts([39], 600)).toBe(15);
    expect(scrapeIntervalFromCounts([41], 600)).toBe(15);
    expect(scrapeIntervalFromCounts([19], 600)).toBe(30);
    expect(scrapeIntervalFromCounts([21], 600)).toBe(30);
    expect(scrapeIntervalFromCounts([11], 600)).toBe(60);
    expect(scrapeIntervalFromCounts([4, 5], 600)).toBe(120);
  });

  it('rounds an unusual interval up, so that a bucket never holds fewer scrapes than planned', () => {
    // 45 s is not a common interval: 600 / 13 = 46.2.
    expect(scrapeIntervalFromCounts([13], 600)).toBe(47);
    expect(scrapeIntervalFromCounts([3], 600)).toBe(200);
  });

  it('returns null without two samples', () => {
    expect(scrapeIntervalFromCounts([], 3600)).toBeNull();
    expect(scrapeIntervalFromCounts([1], 3600)).toBeNull();
    expect(scrapeIntervalFromCounts([NaN], 3600)).toBeNull();
  });
});

describe('planWindow', () => {
  const start = NOW - 10 * HOUR + 7;

  it('uses one-minute buckets on multiples of a minute for a 15 s scrape interval', () => {
    const window = windowOf(planWindow({ startTime: start, endTime: start + 2 * HOUR + 30, nodeCount: 4 }, NOW, 15));
    expect(window.stepSec).toBe(60);
    expect(window.startSec % 60).toBe(0);
    expect(window.endSec % 60).toBe(0);
    expect(window.startSec).toBeGreaterThanOrEqual(start);
    expect(window.startSec - start).toBeLessThan(60);
    expect(window.endSec).toBeLessThanOrEqual(start + 2 * HOUR + 30);
    expect(start + 2 * HOUR + 30 - window.endSec).toBeLessThan(60);
    expect(window.bucketCount).toBe((window.endSec - window.startSec) / 60);
    expect(window).toMatchObject({ running: false, scrapeSec: 15, scrapeMeasured: true, runStartSec: start });
  });

  it.each([
    [15, 60],
    [20, 120],
    [30, 120],
    [60, 240],
    [120, 600],
    [300, 1200],
  ])('makes a bucket at least four scrape intervals long (%s s scrape, %s s buckets)', (scrape, step) => {
    expect(windowOf(planWindow({ startTime: start, endTime: start + 8 * HOUR, nodeCount: 1 }, NOW, scrape)).stepSec).toBe(step);
  });

  it('falls back to a 30 s scrape interval when none was measured', () => {
    const window = windowOf(planWindow({ startTime: start, endTime: start + 2 * HOUR, nodeCount: 1 }, NOW, null));
    expect(window.stepSec).toBe(4 * FALLBACK_SCRAPE_SECONDS);
    expect(window.scrapeMeasured).toBe(false);
  });

  it('never plans more than the largest number of buckets', () => {
    for (const days of [1, 2, 3, 7, 30, 365]) {
      const window = windowOf(planWindow({ startTime: NOW - (days + 1) * 86400, endTime: NOW - 86400, nodeCount: 1 }, NOW, 15));
      expect(window.bucketCount).toBeLessThanOrEqual(MAX_BUCKETS);
      expect(window.bucketCount).toBeGreaterThan(MAX_BUCKETS / 3);
    }
  });

  it('keeps nodes x buckets within the point budget', () => {
    for (const nodeCount of [1, 16, 17, 64, 256, 1000, 1999, MAX_NODES]) {
      for (const hours of [1, 24, 24 * 14]) {
        const plan = windowOf(planWindow({ startTime: NOW - (hours + 1) * HOUR, endTime: NOW - HOUR, nodeCount }, NOW, 15));
        expect(plan.bucketCount * nodeCount).toBeLessThanOrEqual(POINT_BUDGET);
        expect(plan.bucketCount).toBeGreaterThanOrEqual(MIN_BUCKETS);
      }
    }
  });

  it('analyses up to 2000 nodes, and never calls a job too short because of its node count', () => {
    expect(MAX_NODES).toBe(2000);
    // Whatever the run length, the scrape interval and the start time: a job within the node limit
    // is too short exactly when a job of one node with the same run is too short.
    let state = 12345;
    const random = () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
    let refused = 0;
    for (let i = 0; i < 4000; i++) {
      const nodeCount = [2, 100, 1000, 1500, 1999, MAX_NODES][i % 6];
      const scrape = [15, 30, 60, 300][Math.floor(random() * 4)];
      const run = Math.floor(120 + Math.pow(random(), 3) * 40 * 24 * HOUR);
      const start = NOW - 50 * 24 * HOUR + Math.floor(random() * 86400);
      const job = { startTime: start, endTime: start + run, nodeCount };
      const many = planWindow(job, NOW, scrape);
      const one = planWindow({ ...job, nodeCount: 1 }, NOW, scrape);
      expect('refusal' in many).toBe('refusal' in one);
      if ('refusal' in many) {
        refused += 1;
        expect(many).toEqual(one);
      }
    }
    expect(refused).toBeGreaterThan(0);
  });

  it('gives a job with the most nodes at least five buckets when its run is just long enough for the budget', () => {
    // 2000 nodes leave 12 buckets; a run of a little over 12 minutes needs 2-minute buckets, and still has five.
    const plan = windowOf(planWindow({ startTime: NOW - 10 * HOUR, endTime: NOW - 10 * HOUR + 725, nodeCount: MAX_NODES }, NOW, 15));
    expect(plan.stepSec).toBe(120);
    expect(plan.bucketCount).toBeGreaterThanOrEqual(MIN_BUCKETS);
  });

  it('uses coarser buckets for a job with many nodes', () => {
    const one = windowOf(planWindow({ startTime: NOW - 25 * HOUR, endTime: NOW - HOUR, nodeCount: 1 }, NOW, 15));
    const many = windowOf(planWindow({ startTime: NOW - 25 * HOUR, endTime: NOW - HOUR, nodeCount: 256 }, NOW, 15));
    expect(one.stepSec).toBe(60);
    expect(many.stepSec).toBe(1200);
    expect(many.bucketCount * 256).toBeLessThanOrEqual(POINT_BUDGET);
  });

  it('refuses a job with more nodes than the budget allows', () => {
    expect(planWindow({ startTime: start, endTime: start + HOUR, nodeCount: MAX_NODES + 1 }, NOW, 15)).toEqual({
      refusal: 'too-many-nodes',
      maxNodes: MAX_NODES,
    });
  });

  it('refuses a job that has not started or has no node', () => {
    expect(planWindow({ startTime: 0, endTime: 0, nodeCount: 2 }, NOW, 15)).toEqual({ refusal: 'not-started' });
    expect(planWindow({ startTime: start, endTime: 0, nodeCount: 0 }, NOW, 15)).toEqual({ refusal: 'not-started' });
  });

  it('refuses a job that is shorter than five buckets', () => {
    // Ten samples at a 15 s scrape interval are 150 s: at most two one-minute buckets.
    expect(planWindow({ startTime: start, endTime: start + 150, nodeCount: 1 }, NOW, 15)).toEqual({ refusal: 'too-short', stepSec: 60 });
    // Five buckets need up to six minutes, because the buckets lie on full minutes.
    expect(planWindow({ startTime: start, endTime: start + 299, nodeCount: 1 }, NOW, 15)).toEqual({ refusal: 'too-short', stepSec: 60 });
    expect(windowOf(planWindow({ startTime: start, endTime: start + 360, nodeCount: 1 }, NOW, 15)).bucketCount).toBe(5);
    // The same job at a 60 s scrape interval needs four-minute buckets and is too short.
    expect(planWindow({ startTime: start, endTime: start + 360, nodeCount: 1 }, NOW, 60)).toEqual({ refusal: 'too-short', stepSec: 240 });
  });

  it('refuses a job whose end lies before its start', () => {
    expect(planWindow({ startTime: start, endTime: start - 100, nodeCount: 1 }, NOW, 15)).toEqual({ refusal: 'too-short', stepSec: 60 });
  });

  it('analyses a running job up to a moment whose samples are stored', () => {
    const window = windowOf(planWindow({ startTime: NOW - 2 * HOUR, endTime: 0, nodeCount: 1 }, NOW, 15));
    expect(window.running).toBe(true);
    expect(window.runEndSec).toBe(NOW - 90);
    expect(window.endSec).toBeLessThanOrEqual(NOW - 90);
    expect(NOW - window.endSec).toBeLessThan(90 + 60);
  });

  it('does not read past stored samples for a job that ended seconds ago', () => {
    expect(runEnd({ startTime: NOW - HOUR, endTime: NOW - 5, nodeCount: 1 }, NOW, 30)).toBe(NOW - 120);
    expect(runEnd({ startTime: NOW - 3 * HOUR, endTime: NOW - HOUR, nodeCount: 1 }, NOW, 30)).toBe(NOW - HOUR);
  });

  it('refuses a running job that started a minute ago', () => {
    expect(planWindow({ startTime: NOW - 60, endTime: 0, nodeCount: 1 }, NOW, 15)).toEqual({ refusal: 'too-short', stepSec: 60 });
  });
});

describe('probe', () => {
  it('looks back ten minutes from the end of the run', () => {
    expect(PROBE_RANGE_SECONDS).toBe(600);
    expect(probeTime({ startTime: NOW - 10 * HOUR, endTime: NOW - HOUR, nodeCount: 1 }, NOW)).toBe(NOW - HOUR);
    expect(probeTime({ startTime: NOW - 10 * HOUR, endTime: 0, nodeCount: 1 }, NOW)).toBe(NOW - 120);
  });

  it('looks at the GPUs at the end of the run, ten minutes after its start and in its middle', () => {
    const start = NOW - 10 * HOUR;
    expect(gpuProbeTimes({ startTime: start, endTime: NOW - HOUR, nodeCount: 1 }, NOW)).toEqual([NOW - HOUR, start + 600, start + 600 + (9 * HOUR - 600) / 2]);
  });

  it('keeps the GPU probes one probe range apart, so a short job has fewer', () => {
    const start = NOW - 10 * HOUR;
    // 15 minutes: the window after the start overlaps the one at the end.
    expect(gpuProbeTimes({ startTime: start, endTime: start + 900, nodeCount: 1 }, NOW)).toEqual([start + 900]);
    // 25 minutes: two windows, and no room for a third between them.
    expect(gpuProbeTimes({ startTime: start, endTime: start + 1500, nodeCount: 1 }, NOW)).toEqual([start + 1500, start + 600]);
    // 30 minutes: three windows that touch.
    expect(gpuProbeTimes({ startTime: start, endTime: start + 1800, nodeCount: 1 }, NOW)).toEqual([start + 1800, start + 600, start + 1200]);
  });
});
