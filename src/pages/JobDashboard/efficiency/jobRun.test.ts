import { JobRecord } from '../../../api/types';
import { TIME_LIMIT_MARGIN_SECONDS, unscorableRun } from './jobRun';

const START = 1_700_000_040;
const HOUR = 3600;

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
    endTime: START + HOUR,
    exitCode: 0,
    workDir: '/tmp',
    tres: '1=64,1001=8',
    templateId: 'overview',
    ...overrides,
  };
}

describe('unscorableRun', () => {
  const now = START + 10 * HOUR;

  it('accepts a job that was never suspended and ended, or runs within its time limit', () => {
    expect(unscorableRun(makeJob(), now)).toBeUndefined();
    expect(unscorableRun(makeJob({ suspendedSeconds: 0, timeLimitSeconds: 60 }), now)).toBeUndefined();
    expect(unscorableRun(makeJob({ state: 'RUNNING', endTime: 0, timeLimitSeconds: 24 * HOUR }), now)).toBeUndefined();
    // No time limit recorded: nothing to compare the run with.
    expect(unscorableRun(makeJob({ state: 'RUNNING', endTime: 0 }), START + 1000 * HOUR)).toBeUndefined();
    expect(unscorableRun(makeJob({ state: 'RUNNING', endTime: 0, timeLimitSeconds: 0 }), START + 1000 * HOUR)).toBeUndefined();
  });

  it('refuses a job that was suspended, with the time when slurmdbd records it', () => {
    expect(unscorableRun(makeJob({ suspendedSeconds: 600 }), now)).toEqual({ reason: 'suspended', suspendedSeconds: 600 });
    expect(unscorableRun(makeJob({ state: 'RUNNING', endTime: 0, suspendedSeconds: 1 }), now)).toEqual({ reason: 'suspended', suspendedSeconds: 1 });
    // The backend reports -1 when the column holds no duration.
    expect(unscorableRun(makeJob({ suspendedSeconds: -1 }), now)).toEqual({ reason: 'suspended', suspendedSeconds: undefined });
  });

  it('refuses a job that is suspended now, whatever the recorded time', () => {
    expect(unscorableRun(makeJob({ state: 'SUSPENDED', endTime: 0 }), now)).toEqual({ reason: 'suspended', suspendedSeconds: undefined });
    expect(unscorableRun(makeJob({ state: 'SUSPENDED', endTime: 0, suspendedSeconds: 600 }), now)).toEqual({
      reason: 'suspended',
      suspendedSeconds: undefined,
    });
  });

  it('refuses a job recorded as running more than an hour past its time limit', () => {
    const job = makeJob({ state: 'RUNNING', endTime: 0, timeLimitSeconds: 2 * HOUR });

    expect(unscorableRun(job, START + 2 * HOUR + TIME_LIMIT_MARGIN_SECONDS)).toBeUndefined();
    expect(unscorableRun(job, START + 2 * HOUR + TIME_LIMIT_MARGIN_SECONDS + 1)).toEqual({ reason: 'past-time-limit', overSeconds: HOUR + 1 });
    // A job that ended is scored up to its end, however long it ran.
    expect(unscorableRun(makeJob({ endTime: START + 50 * HOUR, timeLimitSeconds: 2 * HOUR }), START + 100 * HOUR)).toBeUndefined();
    // A pending job has no run.
    expect(unscorableRun(makeJob({ state: 'PENDING', startTime: 0, endTime: 0, timeLimitSeconds: 60 }), now)).toBeUndefined();
  });
});
