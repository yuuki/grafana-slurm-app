const mockBackendGet = jest.fn();
const mockBackendPost = jest.fn();

jest.mock('@grafana/runtime', () => ({
  getBackendSrv: () => ({
    get: mockBackendGet,
    post: mockBackendPost,
  }),
}));

import { listLinkableDashboards } from './slurmApi';

describe('slurmApi linked dashboard search', () => {
  beforeEach(() => {
    mockBackendGet.mockReset();
    mockBackendPost.mockReset();
  });

  it('requests tagged Grafana dashboards and normalizes the response', async () => {
    mockBackendGet.mockResolvedValue([
      {
        uid: 'linked-job-dashboard',
        title: 'Linked Job Dashboard',
        url: '/d/linked-job-dashboard/job-detail',
        tags: ['slurm-job-link', 'slurm'],
      },
      {
        uid: 'missing-tags',
        title: 'Missing Tags',
        url: '/d/missing-tags/job-detail',
      },
    ]);

    const dashboards = await listLinkableDashboards('slurm-job-link');

    expect(mockBackendGet).toHaveBeenCalledWith('/api/search?type=dash-db&tag=slurm-job-link');
    expect(dashboards).toEqual([
      {
        uid: 'linked-job-dashboard',
        title: 'Linked Job Dashboard',
        url: '/d/linked-job-dashboard/job-detail',
        tags: ['slurm-job-link', 'slurm'],
      },
      {
        uid: 'missing-tags',
        title: 'Missing Tags',
        url: '/d/missing-tags/job-detail',
        tags: [],
      },
    ]);
  });
});
