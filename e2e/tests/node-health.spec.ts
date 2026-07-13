import { test, expect } from '../fixtures/auth';

test.describe('Node Health Page', () => {
  test('shows seeded node health and links to filtered Job Search', async ({ page }) => {
    await page.goto('/a/yuuki-slurm-app/nodes');
    await page.waitForLoadState('networkidle');

    const tableRows = page.locator('table tbody tr');
    await expect(tableRows.first()).toBeVisible({ timeout: 10000 });
    expect(await tableRows.count()).toBeGreaterThan(0);

    const badNodeRow = tableRows.filter({ hasText: 'gpu-node003' }).first();
    await expect(badNodeRow).toBeVisible();

    const viewJobsLink = badNodeRow.getByRole('link', { name: 'View jobs' });
    await Promise.all([
      page.waitForURL((url) => {
        return (
          url.pathname === '/a/yuuki-slurm-app/jobs' &&
          url.searchParams.get('cluster') === 'gpu_cluster' &&
          url.searchParams.get('node_names') === 'gpu-node003'
        );
      }),
      viewJobsLink.click(),
    ]);

    const jobSearchURL = new URL(page.url());
    expect(jobSearchURL.searchParams.get('node_names')).toBe('gpu-node003');
    await expect(page.getByPlaceholder('node001, node002, ...')).toHaveValue('gpu-node003');
  });
});
