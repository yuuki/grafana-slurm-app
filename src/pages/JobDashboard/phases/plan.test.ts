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
  probeRangeSeconds,
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
    expect(scrapeIntervalFromCounts([240, 239, 12], 3600)).toBe(15);
    expect(scrapeIntervalFromCounts([120], 3600)).toBe(30);
    expect(scrapeIntervalFromCounts([59, 60], 3600)).toBe(60);
    expect(scrapeIntervalFromCounts([10], 600)).toBe(60);
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
    for (const nodeCount of [1, 16, 17, 64, 256, 1000, 4000, MAX_NODES]) {
      for (const hours of [1, 24, 24 * 14]) {
        const plan = planWindow({ startTime: NOW - (hours + 1) * HOUR, endTime: NOW - HOUR, nodeCount }, NOW, 15);
        if ('window' in plan) {
          expect(plan.window.bucketCount * nodeCount).toBeLessThanOrEqual(POINT_BUDGET);
          expect(plan.window.bucketCount).toBeGreaterThanOrEqual(MIN_BUCKETS);
        } else {
          expect(plan.refusal).toBe('too-short');
        }
      }
    }
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
  it('looks back between ten minutes and one hour from the end of the run', () => {
    expect(probeRangeSeconds({ startTime: NOW - 10 * HOUR, endTime: NOW - HOUR, nodeCount: 1 }, NOW)).toBe(3600);
    expect(probeRangeSeconds({ startTime: NOW - HOUR - 1200, endTime: NOW - HOUR, nodeCount: 1 }, NOW)).toBe(1200);
    expect(probeRangeSeconds({ startTime: NOW - HOUR - 100, endTime: NOW - HOUR, nodeCount: 1 }, NOW)).toBe(600);
    expect(probeTime({ startTime: NOW - 10 * HOUR, endTime: NOW - HOUR, nodeCount: 1 }, NOW)).toBe(NOW - HOUR);
    expect(probeTime({ startTime: NOW - 10 * HOUR, endTime: 0, nodeCount: 1 }, NOW)).toBe(NOW - 120);
  });
});
