import { test, expect } from '../../fixtures/auth';

const API_BASE = '/api/plugins/yuuki-slurm-app/resources/api/jobs';
const CLUSTER_ID = 'gpu_cluster';

test.describe('API: Get Job', () => {
  test('returns job details for existing job', async ({ authenticatedRequest }) => {
    const response = await authenticatedRequest.get(`${API_BASE}/${CLUSTER_ID}/10001`);
    expect(response.status()).toBe(200);

    const job = await response.json();
    expect(job.jobId).toBe(10001);
    expect(job.name).toBe('train_llm_70b');
    expect(job.user).toBe('researcher1');
    expect(job.partition).toBe('gpu-a100');
    expect(job.state).toBe('RUNNING');
  });

  test('expands node list correctly', async ({ authenticatedRequest }) => {
    const response = await authenticatedRequest.get(`${API_BASE}/${CLUSTER_ID}/10001`);
    const job = await response.json();

    // gpu-node[001-008] should expand to 8 nodes
    expect(job.nodes).toHaveLength(8);
    expect(job.nodes).toContain('gpu-node001');
    expect(job.nodes).toContain('gpu-node008');
    expect(job.nodeCount).toBe(8);
  });

  test('parses GPU count from TRES', async ({ authenticatedRequest }) => {
    const response = await authenticatedRequest.get(`${API_BASE}/${CLUSTER_ID}/10001`);
    const job = await response.json();

    // tres_alloc: '1=256,2=4096G,1001=gres/gpu:64'
    expect(job.gpusTotal).toBe(64);
  });

  test('returns 404 for nonexistent job', async ({ authenticatedRequest }) => {
    const response = await authenticatedRequest.get(`${API_BASE}/${CLUSTER_ID}/99999`);
    expect(response.status()).toBe(404);
  });

  test('returns 400 for invalid job ID', async ({ authenticatedRequest }) => {
    const response = await authenticatedRequest.get(`${API_BASE}/${CLUSTER_ID}/abc`);
    expect(response.status()).toBe(400);
  });

  test('returns correct data for completed job', async ({ authenticatedRequest }) => {
    const response = await authenticatedRequest.get(`${API_BASE}/${CLUSTER_ID}/10003`);
    expect(response.status()).toBe(200);

    const job = await response.json();
    expect(job.jobId).toBe(10003);
    expect(job.state).toBe('COMPLETED');
    expect(job.endTime).toBeGreaterThan(0);
    expect(job.exitCode).toBe(0);
  });

  test('returns correct data for failed job', async ({ authenticatedRequest }) => {
    const response = await authenticatedRequest.get(`${API_BASE}/${CLUSTER_ID}/10004`);
    expect(response.status()).toBe(200);

    const job = await response.json();
    expect(job.jobId).toBe(10004);
    expect(job.state).toBe('FAILED');
    expect(job.exitCode).not.toBe(0);
  });

  test('handles pending job with no nodes', async ({ authenticatedRequest }) => {
    const response = await authenticatedRequest.get(`${API_BASE}/${CLUSTER_ID}/10006`);
    expect(response.status()).toBe(200);

    const job = await response.json();
    expect(job.jobId).toBe(10006);
    expect(job.state).toBe('PENDING');
    expect(job.startTime).toBe(0);
  });
});
