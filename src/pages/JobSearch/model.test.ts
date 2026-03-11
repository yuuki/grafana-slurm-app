import {
  applyFilterValue,
  buildAutoSearchFilters,
  buildListJobMetadataOptionsParams,
  buildListJobsParams,
  canLookupJob,
  getNextClusterId,
} from './model';

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

  it('keeps the selected cluster when it still exists', () => {
    expect(
      getNextClusterId(
        [
          { id: 'a100' },
          { id: 'h100' },
        ],
        'h100'
      )
    ).toBe('h100');
  });

  it('falls back to the first cluster when the current one is missing', () => {
    expect(
      getNextClusterId(
        [
          { id: 'a100' },
          { id: 'h100' },
        ],
        'missing'
      )
    ).toBe('a100');
  });

  it('clears direct lookup filters for automatic searches', () => {
    expect(
      buildAutoSearchFilters({
        clusterId: 'a100',
        jobId: '10001',
        name: 'train',
        user: 'researcher1',
        account: 'ml-team',
        partition: 'gpu',
        state: 'RUNNING',
      })
    ).toEqual({
      clusterId: 'a100',
      jobId: '',
      name: '',
      user: '',
      account: '',
      partition: '',
      state: '',
    });
  });

  it('clears jobId when a metadata filter changes', () => {
    expect(
      applyFilterValue(
        {
          clusterId: 'a100',
          jobId: '10001',
          user: 'researcher1',
        },
        'user',
        'researcher2'
      )
    ).toEqual({
      clusterId: 'a100',
      jobId: '',
      user: 'researcher2',
    });
  });

  it('keeps jobId for direct lookup edits', () => {
    expect(
      applyFilterValue(
        {
          clusterId: 'a100',
          jobId: '10001',
          user: 'researcher1',
        },
        'jobId',
        '10002'
      )
    ).toEqual({
      clusterId: 'a100',
      jobId: '10002',
      user: 'researcher1',
    });
  });

  it('builds metadata suggestion params with the active cluster and current filters', () => {
    expect(
      buildListJobMetadataOptionsParams(
        {
          clusterId: 'a100',
          name: 'train',
          user: 'researcher1',
          account: 'ml-team',
          partition: 'gpu-a100',
          state: 'RUNNING',
        },
        'user',
        'res'
      )
    ).toEqual({
      clusterId: 'a100',
      field: 'user',
      query: 'res',
      name: 'train',
      account: 'ml-team',
      partition: 'gpu-a100',
      state: 'RUNNING',
      limit: 50,
    });
  });

  it('omits the edited field from metadata suggestion params', () => {
    expect(
      buildListJobMetadataOptionsParams(
        {
          clusterId: 'a100',
          name: 'train',
          user: 'researcher1',
          account: 'ml-team',
          partition: 'gpu-a100',
          state: 'RUNNING',
        },
        'partition',
        'gpu'
      )
    ).toEqual({
      clusterId: 'a100',
      field: 'partition',
      query: 'gpu',
      name: 'train',
      user: 'researcher1',
      account: 'ml-team',
      state: 'RUNNING',
      limit: 50,
    });
  });
});
