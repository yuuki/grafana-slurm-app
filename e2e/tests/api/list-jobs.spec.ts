import { test, expect } from '../../fixtures/auth';

const API_BASE = '/api/plugins/yuuki-slurm-app/resources/api/jobs';
const CLUSTER_ID = 'gpu_cluster';

test.describe('API: List Jobs', () => {
  test('returns jobs without filters', async ({ authenticatedRequest }) => {
    const response = await authenticatedRequest.get(`${API_BASE}?clusterId=${CLUSTER_ID}`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.jobs).toBeDefined();
    expect(Array.isArray(body.jobs)).toBe(true);
    expect(body.jobs.length).toBeGreaterThan(0);
  });

  test('filters by user', async ({ authenticatedRequest }) => {
    const response = await authenticatedRequest.get(`${API_BASE}?clusterId=${CLUSTER_ID}&user=researcher1`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.jobs.length).toBeGreaterThan(0);
    for (const job of body.jobs) {
      expect(job.user).toBe('researcher1');
    }
  });

  test('filters by state RUNNING', async ({ authenticatedRequest }) => {
    const response = await authenticatedRequest.get(`${API_BASE}?clusterId=${CLUSTER_ID}&state=RUNNING`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.jobs.length).toBeGreaterThan(0);
    for (const job of body.jobs) {
      expect(job.state).toBe('RUNNING');
    }
  });

  test('filters by partition', async ({ authenticatedRequest }) => {
    const response = await authenticatedRequest.get(`${API_BASE}?clusterId=${CLUSTER_ID}&partition=gpu-h100`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.jobs.length).toBeGreaterThan(0);
    for (const job of body.jobs) {
      expect(job.partition).toBe('gpu-h100');
    }
  });

  test('filters by name (partial match)', async ({ authenticatedRequest }) => {
    const response = await authenticatedRequest.get(`${API_BASE}?clusterId=${CLUSTER_ID}&name=train`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.jobs.length).toBeGreaterThan(0);
    for (const job of body.jobs) {
      expect(job.name.toLowerCase()).toContain('train');
    }
  });

  test('supports limit and offset', async ({ authenticatedRequest }) => {
    const page1 = await authenticatedRequest.get(`${API_BASE}?clusterId=${CLUSTER_ID}&limit=2&cursor=MA==`);
    const page2 = await authenticatedRequest.get(`${API_BASE}?clusterId=${CLUSTER_ID}&limit=2&cursor=Mg==`);
    expect(page1.status()).toBe(200);
    expect(page2.status()).toBe(200);

    const body1 = await page1.json();
    const body2 = await page2.json();
    expect(body1.jobs.length).toBe(2);
    expect(body2.jobs.length).toBe(2);

    const ids1 = body1.jobs.map((j: { jobId: number }) => j.jobId);
    const ids2 = body2.jobs.map((j: { jobId: number }) => j.jobId);
    expect(ids1).not.toEqual(ids2);
  });

  test('combines user and state filters', async ({ authenticatedRequest }) => {
    const response = await authenticatedRequest.get(`${API_BASE}?clusterId=${CLUSTER_ID}&user=researcher1&state=COMPLETED`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.jobs.length).toBeGreaterThan(0);
    for (const job of body.jobs) {
      expect(job.user).toBe('researcher1');
      expect(job.state).toBe('COMPLETED');
    }
  });

  test('returns empty array for nonexistent user', async ({ authenticatedRequest }) => {
    const response = await authenticatedRequest.get(`${API_BASE}?clusterId=${CLUSTER_ID}&user=nonexistent_user_xyz`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.jobs).toEqual([]);
  });
});
