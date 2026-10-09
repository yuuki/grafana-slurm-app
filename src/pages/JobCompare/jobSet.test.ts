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
