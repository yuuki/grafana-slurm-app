/**
 * Accuracy of the phase segmentation on synthetic jobs with a known timeline
 * and noise (__fixtures__/syntheticJob.ts). The tests assert the bounds that
 * the design document states. Run with PHASE_REPORT=1 to print the measured
 * confusion and boundary errors:
 *
 *   PHASE_REPORT=1 npx jest src/pages/JobDashboard/phases/accuracy.test.ts
 */
import { DEFAULT_PHASE_THRESHOLDS, segmentPhases } from './segment';
import { PHASE_ORDER, PhaseId, PhaseResult } from './types';
import {
  alignedGrid,
  bucketTruth,
  BucketGrid,
  expectedLabel,
  generateSyntheticJob,
  SyntheticJob,
  SyntheticJobSpec,
  SyntheticStage,
  syntheticSpec,
  toPhaseInput,
  TruthPhase,
} from './__fixtures__/syntheticJob';

const MINUTE = 60;
const report: string[] = [];

afterAll(() => {
  if (process.env.PHASE_REPORT) {
    console.log(report.join('\n'));
  }
});

function stage(phase: TruthPhase, minutes: number): SyntheticStage {
  return { phase, seconds: Math.round(minutes * MINUTE) };
}

/** Startup, three compute stretches with two checkpoints between them, then a stall. */
const TYPICAL: SyntheticStage[] = [
  stage('init', 7),
  stage('compute', 40),
  stage('checkpoint', 2),
  stage('compute', 40),
  stage('checkpoint', 3),
  stage('compute', 40),
  stage('stalled', 25),
];

interface Evaluation {
  job: SyntheticJob;
  grid: BucketGrid;
  result: PhaseResult;
  /** Buckets that one stage fills completely. */
  pure: number;
  pureCorrect: number;
  /** Buckets in which two stages meet. */
  mixed: number;
  /** Seconds by expected label, then by given label. */
  confusion: Map<PhaseId, Map<PhaseId, number>>;
  /** Distance in seconds from each true change of label to the nearest reported one. */
  boundaryErrors: number[];
}

type ExpectedOf = (phase: TruthPhase, bucket: number, grid: BucketGrid, job: SyntheticJob) => PhaseId;

function evaluate(spec: SyntheticJobSpec, stepSec: number, expectedOf: ExpectedOf = expectedLabel): Evaluation {
  const job = generateSyntheticJob(spec);
  const grid = alignedGrid(job, stepSec);
  const result = segmentPhases(toPhaseInput(job, grid), DEFAULT_PHASE_THRESHOLDS);
  const evaluation: Evaluation = { job, grid, result, pure: 0, pureCorrect: 0, mixed: 0, confusion: new Map(), boundaryErrors: [] };

  bucketTruth(job, grid).forEach((truth, bucket) => {
    const expected = expectedOf(truth.phase, bucket, grid, job);
    const given = result.labels[bucket];
    const row = evaluation.confusion.get(expected) ?? new Map<PhaseId, number>();
    row.set(given, (row.get(given) ?? 0) + stepSec);
    evaluation.confusion.set(expected, row);
    if (truth.seconds < stepSec) {
      evaluation.mixed += 1;
      return;
    }
    evaluation.pure += 1;
    evaluation.pureCorrect += given === expected ? 1 : 0;
  });

  const reported = result.segments.slice(1).map((segment) => segment.fromSec);
  let cursor = job.startSec;
  spec.stages.slice(0, -1).forEach((current, index) => {
    cursor += current.seconds;
    if (expectedLabel(current.phase) !== expectedLabel(spec.stages[index + 1].phase)) {
      evaluation.boundaryErrors.push(Math.min(...reported.map((time) => Math.abs(time - cursor)), Infinity));
    }
  });
  return evaluation;
}

function summarize(name: string, evaluation: Evaluation): void {
  const errors = evaluation.boundaryErrors.filter(Number.isFinite);
  const mean = errors.length > 0 ? errors.reduce((sum, value) => sum + value, 0) / errors.length : 0;
  report.push(
    `${name}: ${evaluation.grid.bucketCount} buckets of ${evaluation.grid.stepSec} s; ` +
      `pure buckets correct ${evaluation.pureCorrect}/${evaluation.pure}; mixed buckets ${evaluation.mixed}; ` +
      `boundary error mean ${mean.toFixed(1)} s, max ${Math.max(0, ...errors)} s`
  );
  for (const expected of PHASE_ORDER) {
    const row = evaluation.confusion.get(expected);
    if (row) {
      const cells = PHASE_ORDER.filter((given) => row.has(given)).map((given) => `${given} ${row.get(given)! / MINUTE} min`);
      report.push(`    expected ${expected}: ${cells.join(', ')}`);
    }
  }
}

function expectAllPureCorrect(evaluation: Evaluation): void {
  expect(evaluation.pureCorrect).toBe(evaluation.pure);
}

function expectBoundariesWithinOneBucket(evaluation: Evaluation): void {
  expect(evaluation.boundaryErrors.length).toBeGreaterThan(0);
  for (const error of evaluation.boundaryErrors) {
    expect(error).toBeLessThanOrEqual(evaluation.grid.stepSec);
  }
}

describe('accuracy on synthetic jobs', () => {
  it.each([
    ['15 s scrape, 60 s buckets', 15, 60],
    ['30 s scrape, 120 s buckets', 30, 120],
    ['60 s scrape, 240 s buckets', 60, 240],
  ])('labels every pure bucket of a typical job correctly (%s)', (name, scrapeSec, stepSec) => {
    // The same job in units of buckets: its checkpoints last two and three buckets.
    const stages = TYPICAL.map((item) => ({ ...item, seconds: (item.seconds * stepSec) / 60 }));
    for (let seed = 1; seed <= 20; seed++) {
      const evaluation = evaluate(syntheticSpec(stages, { seed, scrapeSec, startSec: 1_750_000_000 + seed * 13 }), stepSec);
      expectAllPureCorrect(evaluation);
      expectBoundariesWithinOneBucket(evaluation);
      if (seed === 1) {
        summarize(`typical, ${name}`, evaluation);
      }
    }
  });

  it('keeps the result under strong noise (25% of the working level)', () => {
    const evaluation = evaluate(syntheticSpec(TYPICAL, { noise: 0.25, seed: 3 }), 60);
    summarize('typical, noise 25%', evaluation);
    expectAllPureCorrect(evaluation);
    expectBoundariesWithinOneBucket(evaluation);
  });

  it('segments a power-capped job (110 W working, 60 W idle)', () => {
    const evaluation = evaluate(syntheticSpec(TYPICAL, { busyWatts: 110, idleWatts: 60, seed: 4 }), 60);
    summarize('power-capped', evaluation);
    expectAllPureCorrect(evaluation);
    expectBoundariesWithinOneBucket(evaluation);
    expect(evaluation.result.workingLevel.gpuPowerWatts).toBeGreaterThan(100);
  });

  it('segments a job with low GPU load (30% utilization, 120 W)', () => {
    const evaluation = evaluate(syntheticSpec(TYPICAL, { busyUtil: 30, busyWatts: 120, seed: 5 }), 60);
    summarize('low GPU load', evaluation);
    expectAllPureCorrect(evaluation);
  });

  it('reports checkpoints as unclassified, never as a phase, when the cluster has no disk series', () => {
    const noDisk: ExpectedOf = (phase) => (phase === 'checkpoint' ? 'unclassified' : expectedLabel(phase));
    const evaluation = evaluate(syntheticSpec(TYPICAL, { without: ['storageWrite'], seed: 6 }), 60, noDisk);
    summarize('no disk series', evaluation);
    expectAllPureCorrect(evaluation);
    expect(evaluation.result.labels).not.toContain('checkpoint');
    expect(evaluation.result.unclassifiedReasons.map((total) => total.reason)).toEqual(['gpu-low-write-unknown']);
    expect(evaluation.result.coverage.storageWrite).toBe(0);
  });

  it('works without network and CPU series', () => {
    const evaluation = evaluate(syntheticSpec(TYPICAL, { without: ['network', 'cpu'], seed: 7 }), 60);
    summarize('no network and CPU series', evaluation);
    expectAllPureCorrect(evaluation);
  });

  it('keeps the job phases and names the node when one node of eight stalls', () => {
    const spec = syntheticSpec(TYPICAL, { nodeCount: 8, stalledNodes: [{ node: 5, fromSec: 30 * MINUTE }], seed: 8 });
    const evaluation = evaluate(spec, 60);
    summarize('one stalled node of eight', evaluation);
    expectAllPureCorrect(evaluation);
    expect(evaluation.result.nodeFindings.map((finding) => finding.nodeIndex)).toEqual([5, 5, 5]);
    const idleSeconds = evaluation.result.nodeFindings.reduce((sum, finding) => sum + finding.toSec - finding.fromSec, 0);
    // The node is idle through 17 + 40 + 40 minutes of compute; the bucket in which it stops is not idle yet.
    expect(idleSeconds).toBeGreaterThanOrEqual(95 * MINUTE);
    expect(idleSeconds).toBeLessThanOrEqual(97 * MINUTE);
  });

  it('labels a scrape gap as no data and keeps the phases around it', () => {
    const gap = { fromSec: 60 * MINUTE, toSec: 75 * MINUTE };
    const inGap: ExpectedOf = (phase, bucket, grid, job) => {
      const from = grid.startSec + bucket * grid.stepSec - job.startSec;
      return from >= gap.fromSec && from + grid.stepSec <= gap.toSec ? 'no-data' : expectedLabel(phase);
    };
    const evaluation = evaluate(syntheticSpec(TYPICAL, { gaps: [{ node: 'all', ...gap }], seed: 9 }), 60, inGap);
    summarize('15 min gap on every node', evaluation);
    const noData = evaluation.result.totals.find((total) => total.phase === 'no-data');
    expect(noData?.seconds).toBeGreaterThanOrEqual(14 * MINUTE);
    expect(noData?.seconds).toBeLessThanOrEqual(15 * MINUTE);
    // The buckets at the edges of the gap hold a few samples and are labelled from them.
    expect(evaluation.pure - evaluation.pureCorrect).toBeLessThanOrEqual(2);
  });

  it('claims a stall only for the buckets in which every node reports, when one node of four has a gap', () => {
    const spec = syntheticSpec(TYPICAL, { nodeCount: 4, gaps: [{ node: 1, fromSec: 140 * MINUTE, toSec: 150 * MINUTE }], seed: 10 });
    const evaluation = evaluate(spec, 60);
    summarize('gap on one node of four during the stall', evaluation);
    const partial = evaluation.result.unclassifiedReasons.find((total) => total.reason === 'gpu-idle-partial-telemetry');
    expect(partial?.seconds).toBeGreaterThanOrEqual(9 * MINUTE);
    expect(partial?.seconds).toBeLessThanOrEqual(10 * MINUTE);
    const stalled = evaluation.result.totals.find((total) => total.phase === 'stalled');
    expect(stalled?.seconds).toBeGreaterThanOrEqual(14 * MINUTE);
    expect(stalled?.seconds).toBeLessThanOrEqual(15 * MINUTE);
  });

  it('claims no stall when one node of two has a gap that leaves less than the stall time on each side', () => {
    // 8 minutes with both nodes idle, 10 minutes with one node unknown, 7 minutes with both idle.
    const spec = syntheticSpec(TYPICAL, { gaps: [{ node: 1, fromSec: 140 * MINUTE, toSec: 150 * MINUTE }], seed: 10 });
    const evaluation = evaluate(spec, 60);
    summarize('gap on one node of two during the stall', evaluation);
    expect(evaluation.result.labels).not.toContain('stalled');
    expect(evaluation.result.unclassifiedReasons.map((total) => total.reason)).toEqual(['gpu-low', 'partial-telemetry']);
  });

  it('leaves short idle stretches between steps unclassified instead of calling them stalls', () => {
    const stages: SyntheticStage[] = [stage('init', 5)];
    for (let i = 0; i < 6; i++) {
      stages.push(stage('compute', 20), stage('gap', 4));
    }
    stages.push(stage('compute', 10));
    const evaluation = evaluate(syntheticSpec(stages, { seed: 11 }), 60);
    summarize('idle 4 min between steps', evaluation);
    expectAllPureCorrect(evaluation);
    expect(evaluation.result.labels).not.toContain('stalled');
    expect(evaluation.result.unclassifiedReasons.map((total) => total.reason)).toEqual(['gpu-low']);
  });

  it('leaves a long stretch of CPU work with idle GPUs unclassified', () => {
    const stages = [stage('init', 5), stage('compute', 30), stage('cpu-work', 25), stage('compute', 30)];
    const evaluation = evaluate(syntheticSpec(stages, { seed: 12 }), 60);
    summarize('25 min CPU work with idle GPUs', evaluation);
    expectAllPureCorrect(evaluation);
    expect(evaluation.result.labels).not.toContain('stalled');
    expect(evaluation.result.unclassifiedReasons.map((total) => total.reason)).toContain('gpu-idle-cpu-busy');
  });

  it('finds the stall of a job that hangs three minutes after its startup', () => {
    const stages = [stage('init', 4), stage('compute', 3), stage('stalled', 180)];
    const evaluation = evaluate(syntheticSpec(stages, { seed: 13 }), 60);
    summarize('early hang', evaluation);
    expectAllPureCorrect(evaluation);
    const stalled = evaluation.result.totals.find((total) => total.phase === 'stalled');
    expect(stalled?.share).toBeGreaterThan(0.95);
  });

  it('does not call a job stalled whose GPUs are never used', () => {
    const evaluation = evaluate(syntheticSpec([stage('cpu-work', 120)], { seed: 14 }), 60);
    summarize('GPUs never used', evaluation);
    expect(evaluation.result.labels.every((label) => label === 'unclassified')).toBe(true);
    expect(evaluation.result.unclassifiedReasons.map((total) => total.reason)).toEqual(['no-compute']);
  });

  it('segments a job of three days in buckets of five minutes', () => {
    const stages: SyntheticStage[] = [stage('init', 30)];
    for (let i = 0; i < 11; i++) {
      stages.push(stage('compute', 345), stage('checkpoint', 15));
    }
    stages.push(stage('compute', 150), stage('stalled', 180));
    const evaluation = evaluate(syntheticSpec(stages, { seed: 15, nodeCount: 2, gpusPerNode: 2 }), 300);
    summarize('three days, 300 s buckets', evaluation);
    expectAllPureCorrect(evaluation);
    expectBoundariesWithinOneBucket(evaluation);
    expect(evaluation.grid.bucketCount).toBeGreaterThan(850);
  });
});

describe('what the resolution hides', () => {
  const SWEEP_JOBS = 16;

  /** Share of the true checkpoint time that is reported as checkpoint, over many placements. */
  function checkpointRecall(checkpointSeconds: number, stepSec: number): { reported: number; truth: number; jobsWithAny: number } {
    const totals = { reported: 0, truth: 0, jobsWithAny: 0 };
    for (let seed = 1; seed <= SWEEP_JOBS; seed++) {
      const stages: SyntheticStage[] = [stage('init', 5)];
      for (let i = 0; i < 5; i++) {
        stages.push(stage('compute', 17), { phase: 'checkpoint', seconds: checkpointSeconds });
      }
      stages.push(stage('compute', 10));
      const evaluation = evaluate(syntheticSpec(stages, { seed, startSec: 1_750_000_000 + seed * 7 }), stepSec);
      const reported = evaluation.result.totals.find((total) => total.phase === 'checkpoint')?.seconds ?? 0;
      totals.reported += reported;
      totals.truth += 5 * checkpointSeconds;
      totals.jobsWithAny += reported > 0 ? 1 : 0;
      expect(evaluation.result.labels).not.toContain('stalled');
    }
    return totals;
  }

  it('reports the share of checkpoint time by checkpoint length (60 s buckets)', () => {
    const rows = [15, 30, 45, 60, 90, 120, 180, 300].map((seconds) => ({ seconds, ...checkpointRecall(seconds, 60) }));
    report.push(`checkpoint time reported, by checkpoint length (60 s buckets, ${SWEEP_JOBS} jobs of 5 checkpoints each):`);
    for (const row of rows) {
      report.push(`    ${row.seconds} s: ${((100 * row.reported) / row.truth).toFixed(0)}% of the true time; ${row.jobsWithAny}/${SWEEP_JOBS} jobs show a checkpoint`);
    }
    const share = (seconds: number) => {
      const row = rows.find((item) => item.seconds === seconds)!;
      return row.reported / row.truth;
    };
    // Much shorter than a bucket: the GPUs never drop for most of a bucket, so nothing is reported.
    expect(share(15)).toBe(0);
    // About half a bucket: reported in some placements only, and then as one whole bucket.
    expect(share(30)).toBeLessThan(0.5);
    // From two buckets on, every checkpoint is seen, and the reported time is within a bucket of the truth.
    expect(share(120)).toBeGreaterThan(0.7);
    expect(share(300)).toBeGreaterThan(0.85);
    // The reported time never exceeds the truth by more than one bucket per checkpoint.
    for (const row of rows) {
      expect(row.reported).toBeLessThanOrEqual(row.truth + SWEEP_JOBS * 5 * 60);
    }
  });
});
