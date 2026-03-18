import {
  applyFilterValue,
  buildAutoSearchFilters,
  buildListJobMetadataOptionsParams,
  buildListJobsParams,
  durationToSeconds,
  JOBS_PAGE_SIZE,
  canLookupJob,
  getNextClusterId,
  secondsToDuration,
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
      limit: JOBS_PAGE_SIZE,
    });
  });

  it('builds paginated list job params with a cursor', () => {
    expect(
      buildListJobsParams(
        {
          clusterId: 'a100',
          account: 'ml-team',
          user: 'researcher1',
          partition: 'gpu-a100',
          state: 'RUNNING',
          name: 'train',
        },
        { cursor: 'MTAw' }
      )
    ).toEqual({
      clusterId: 'a100',
      account: 'ml-team',
      user: 'researcher1',
      partition: 'gpu-a100',
      state: 'RUNNING',
      name: 'train',
      limit: JOBS_PAGE_SIZE,
      cursor: 'MTAw',
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
      nodesMin: '',
      nodesMax: '',
      elapsedMin: '',
      elapsedMax: '',
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

  it('includes range filters in list job params', () => {
    expect(
      buildListJobsParams({
        clusterId: 'a100',
        nodesMin: '2',
        nodesMax: '8',
        elapsedMin: '3600',
        elapsedMax: '86400',
      })
    ).toMatchObject({
      clusterId: 'a100',
      nodesMin: 2,
      nodesMax: 8,
      elapsedMin: 3600,
      elapsedMax: 86400,
    });
  });

  it('omits range filters when empty', () => {
    const params = buildListJobsParams({
      clusterId: 'a100',
      nodesMin: '',
      nodesMax: '',
      elapsedMin: '',
      elapsedMax: '',
    });
    expect(params.nodesMin).toBeUndefined();
    expect(params.nodesMax).toBeUndefined();
    expect(params.elapsedMin).toBeUndefined();
    expect(params.elapsedMax).toBeUndefined();
  });

  it('includes range filters in metadata options params', () => {
    expect(
      buildListJobMetadataOptionsParams(
        {
          clusterId: 'a100',
          nodesMin: '4',
          nodesMax: '16',
          elapsedMin: '7200',
          elapsedMax: '43200',
        },
        'user',
        ''
      )
    ).toMatchObject({
      nodesMin: 4,
      nodesMax: 16,
      elapsedMin: 7200,
      elapsedMax: 43200,
    });
  });

  it('converts hours and minutes to seconds', () => {
    expect(durationToSeconds('1', '30')).toBe('5400');
    expect(durationToSeconds('2', '0')).toBe('7200');
    expect(durationToSeconds('0', '45')).toBe('2700');
    expect(durationToSeconds('0', '0')).toBe('');
    expect(durationToSeconds('', '')).toBe('');
  });

  it('converts seconds to hours and minutes', () => {
    expect(secondsToDuration('5400')).toEqual({ hours: '1', minutes: '30' });
    expect(secondsToDuration('7200')).toEqual({ hours: '2', minutes: '' });
    expect(secondsToDuration('2700')).toEqual({ hours: '', minutes: '45' });
    expect(secondsToDuration('')).toEqual({ hours: '', minutes: '' });
    expect(secondsToDuration('0')).toEqual({ hours: '', minutes: '' });
  });
});
