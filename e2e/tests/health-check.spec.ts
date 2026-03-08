import { test, expect } from '../fixtures/auth';

test.describe('Health Check', () => {
  test('plugin health check returns ok', async ({ authenticatedRequest }) => {
    const response = await authenticatedRequest.get('/api/plugins/yuuki-slurm-app/health');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('ok');
  });
});
