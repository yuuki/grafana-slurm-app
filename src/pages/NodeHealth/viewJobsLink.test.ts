import { buildViewJobsUrl } from './viewJobsLink';

describe('buildViewJobsUrl', () => {
  it('uses the exact Job Search URL-sync parameter names and absolute time values', () => {
    const fromMs = Date.UTC(2026, 6, 6, 0, 0, 0);
    const toMs = Date.UTC(2026, 6, 13, 0, 0, 0);

    const url = new URL(buildViewJobsUrl('cluster a', 'gpu-node003', fromMs, toMs), 'http://localhost');

    expect(url.pathname).toBe('/a/yuuki-slurm-app/jobs');
    expect(Array.from(url.searchParams.keys())).toEqual(['cluster', 'node_names', 'from', 'to']);
    expect(url.searchParams.get('cluster')).toBe('cluster a');
    expect(url.searchParams.get('node_names')).toBe('gpu-node003');
    expect(url.searchParams.get('from')).toBe('2026-07-06T00:00:00.000Z');
    expect(url.searchParams.get('to')).toBe('2026-07-13T00:00:00.000Z');
  });
});
