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

  test('shows metadata section', async ({ page }) => {
    const dashboard = new JobDashboardPage(page);
    await dashboard.goto('10001');

    const hasMetadata = await dashboard.hasMetadataSection();
    expect(hasMetadata).toBe(true);
  });

  test('shows metric explorer section', async ({ page }) => {
    const dashboard = new JobDashboardPage(page);
    await dashboard.goto('10001');

    const hasMetricExplorer = await dashboard.hasMetricExplorerSection();
    expect(hasMetricExplorer).toBe(true);
  });

  test('shows recommended views section', async ({ page }) => {
    const dashboard = new JobDashboardPage(page);
    await dashboard.goto('10001');

    const hasRecommendedViews = await dashboard.hasRecommendedViewsSection();
    expect(hasRecommendedViews).toBe(true);
  });

  test('shows job metadata cards', async ({ page }) => {
    const dashboard = new JobDashboardPage(page);
    await dashboard.goto('10001');

    expect(await dashboard.hasMetadataCard('Job ID')).toBe(true);
    expect(await dashboard.hasMetadataCard('Name')).toBe(true);
    expect(await dashboard.hasMetadataCard('User')).toBe(true);
    expect(await dashboard.hasMetadataCard('State')).toBe(true);
  });

  test('shows error for nonexistent job', async ({ page }) => {
    const dashboard = new JobDashboardPage(page);
    await dashboard.goto('99999');

    await expect(page.getByText('Failed to load job')).toBeVisible({ timeout: 10000 });
  });
});
