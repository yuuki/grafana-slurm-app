import { test, expect } from '../fixtures/auth';
import { JobDashboardPage } from '../pages/JobDashboardPage';

test.describe('Job Dashboard Page', () => {
  test('displays dashboard for existing job', async ({ page }) => {
    const dashboard = new JobDashboardPage(page);
    await dashboard.goto('10001');

    // Should not show error
    const hasError = await dashboard.hasError();
    expect(hasError).toBe(false);
  });

  test('shows overview section', async ({ page }) => {
    const dashboard = new JobDashboardPage(page);
    await dashboard.goto('10001');

    // Overview section should contain job info
    await expect(page.getByText('train_llm_70b')).toBeVisible({ timeout: 10000 });
  });

  test('shows GPU metrics section', async ({ page }) => {
    const dashboard = new JobDashboardPage(page);
    await dashboard.goto('10001');

    const hasGpu = await dashboard.hasGpuSection();
    expect(hasGpu).toBe(true);
  });

  test('shows CPU / Memory section', async ({ page }) => {
    const dashboard = new JobDashboardPage(page);
    await dashboard.goto('10001');

    const hasCpu = await dashboard.hasCpuMemorySection();
    expect(hasCpu).toBe(true);
  });

  test('shows Network section', async ({ page }) => {
    const dashboard = new JobDashboardPage(page);
    await dashboard.goto('10001');

    const hasNetwork = await dashboard.hasNetworkSection();
    expect(hasNetwork).toBe(true);
  });

  test('shows Disk I/O section', async ({ page }) => {
    const dashboard = new JobDashboardPage(page);
    await dashboard.goto('10001');

    const hasDisk = await dashboard.hasDiskSection();
    expect(hasDisk).toBe(true);
  });

  test('shows error for nonexistent job', async ({ page }) => {
    const dashboard = new JobDashboardPage(page);
    await dashboard.goto('99999');

    // Should show error alert
    await expect(page.locator('[class*="Alert"]').first()).toBeVisible({ timeout: 10000 });
  });
});
