import { buildListJobsParams, canLookupJob } from './model';

describe('job search model', () => {
  it('requires cluster selection before direct job lookup', () => {
    expect(canLookupJob({ clusterId: '', jobId: '12345' })).toBe(false);
    expect(canLookupJob({ clusterId: 'a100', jobId: '12345' })).toBe(true);
  });

  it('builds cluster-scoped list job params', () => {
    expect(
      buildListJobsParams({
        clusterId: 'a100',
        account: 'ml-team',
        user: 'researcher1',
        partition: 'gpu-a100',
        state: 'RUNNING',
        name: 'train',
      })
    ).toEqual({
      clusterId: 'a100',
      account: 'ml-team',
      user: 'researcher1',
      partition: 'gpu-a100',
      state: 'RUNNING',
      name: 'train',
      limit: 100,
    });
  });
});
