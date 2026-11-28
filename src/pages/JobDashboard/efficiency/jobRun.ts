import { JobRecord } from '../../../api/types';

/**
 * A job that slurmdbd records as running this long past its time limit is
 * taken for a job whose end the accounting database missed. The margin
 * leaves room for the grace time a cluster may give (OverTimeLimit).
 */
export const TIME_LIMIT_MARGIN_SECONDS = 3600;

/**
 * Why the telemetry of a job's nodes between its start and its end is not
 * the job's, whatever the metrics hold:
 *
 * - suspended: the job was suspended for a part of its run (or is now). A
 *   suspended job keeps its allocation but does not run, and its GPUs may
 *   run another job meanwhile. The backend reads only the total time
 *   (time_suspended of the job table), so the suspended time cannot be cut
 *   out of the telemetry. slurmdbd does record the start and end of every
 *   suspension, in <cluster>_suspend_table: reading that table is the way
 *   to exclude the suspended spans and score such a job.
 * - past-time-limit: slurmdbd records the job as running although its time
 *   limit passed long ago. Its end is probably missing from the database
 *   (a runaway job), and its nodes may run other jobs by now.
 */
export type UnscorableRun =
  | { reason: 'suspended'; /** undefined when slurmdbd holds no duration. */ suspendedSeconds?: number }
  | { reason: 'past-time-limit'; overSeconds: number };

export function unscorableRun(job: JobRecord, nowSeconds: number): UnscorableRun | undefined {
  const suspended = job.suspendedSeconds ?? 0;
  if (job.state === 'SUSPENDED' || suspended !== 0) {
    return { reason: 'suspended', suspendedSeconds: job.state !== 'SUSPENDED' && suspended > 0 ? suspended : undefined };
  }
  const limit = job.timeLimitSeconds ?? 0;
  if (job.startTime > 0 && job.endTime <= 0 && limit > 0) {
    const overSeconds = nowSeconds - job.startTime - limit;
    if (overSeconds > TIME_LIMIT_MARGIN_SECONDS) {
      return { reason: 'past-time-limit', overSeconds };
    }
  }
  return undefined;
}
