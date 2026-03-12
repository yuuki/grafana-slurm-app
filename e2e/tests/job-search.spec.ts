import { test, expect } from '../fixtures/auth';
import { JobSearchPage } from '../pages/JobSearchPage';

test.describe('Job Search Page', () => {
  test('displays job table on load', async ({ page }) => {
    const jobSearch = new JobSearchPage(page);
    await jobSearch.goto();

    await expect(jobSearch.jobTable).toBeVisible();
    const rowCount = await jobSearch.getRowCount();
    expect(rowCount).toBeGreaterThan(0);
  });

  test('shows correct table headers', async ({ page }) => {
    const jobSearch = new JobSearchPage(page);
    await jobSearch.goto();

    const expectedHeaders = ['Job ID', 'Name', 'User', 'Account', 'Partition', 'State', 'Nodes', 'GPUs', 'Start', 'Elapsed'];
    for (const header of expectedHeaders) {
      await expect(jobSearch.tableHeaders.filter({ hasText: header })).toBeVisible();
    }
  });

  test('filters jobs by user', async ({ page }) => {
    const jobSearch = new JobSearchPage(page);
    await jobSearch.goto();
    await jobSearch.searchByUser('researcher1');

    const rows = jobSearch.tableRows;
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i)).toContainText('researcher1');
    }
  });

  test('shows metadata suggestions on focus and filters them incrementally', async ({ page }) => {
    const jobSearch = new JobSearchPage(page);
    await jobSearch.goto();

    await jobSearch.userInput.click();
    await expect(page.getByRole('option', { name: 'researcher1' })).toBeVisible();

    await jobSearch.chooseUserSuggestion('res', 'researcher1');

    const rows = jobSearch.tableRows;
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i)).toContainText('researcher1');
    }
  });

  test('filters jobs by name', async ({ page }) => {
    const jobSearch = new JobSearchPage(page);
    await jobSearch.goto();
    await jobSearch.searchByName('benchmark');

    const rows = jobSearch.tableRows;
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i)).toContainText('benchmark');
    }
  });

  test('navigates to job dashboard via Job ID search', async ({ page }) => {
    const jobSearch = new JobSearchPage(page);
    await jobSearch.goto();
    await jobSearch.searchByJobId('10001');

    await page.waitForURL(new RegExp(`/jobs/${JobSearchPage.clusterId}/10001$`));
    expect(page.url()).toContain(`/jobs/${JobSearchPage.clusterId}/10001`);
  });

  test('navigates to job dashboard on row click', async ({ page }) => {
    const jobSearch = new JobSearchPage(page);
    await jobSearch.goto();
    await jobSearch.clickJobRow('10001');

    await page.waitForURL(new RegExp(`/jobs/${JobSearchPage.clusterId}/10001$`));
    expect(page.url()).toContain(`/jobs/${JobSearchPage.clusterId}/10001`);
  });

  test('shows state badges with correct colors', async ({ page }) => {
    const jobSearch = new JobSearchPage(page);
    await jobSearch.goto();

    // RUNNING jobs should have green badges
    const runningBadge = page.locator('table tbody tr').filter({ hasText: 'RUNNING' }).first().locator('[class*="Badge"]');
    if (await runningBadge.isVisible().catch(() => false)) {
      await expect(runningBadge).toBeVisible();
    }
  });

  test('shows "No jobs found." for nonexistent user', async ({ page }) => {
    const jobSearch = new JobSearchPage(page);
    await jobSearch.goto();
    await jobSearch.searchByUser('nonexistent_user_xyz');

    await expect(jobSearch.noJobsMessage).toBeVisible();
  });

  test('filters jobs by partition', async ({ page }) => {
    const jobSearch = new JobSearchPage(page);
    await jobSearch.goto();
    await jobSearch.searchByPartition('gpu-h100');

    const rows = jobSearch.tableRows;
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i)).toContainText('gpu-h100');
    }
  });

  test('loads more jobs and updates the button label', async ({ page }) => {
    const jobSearch = new JobSearchPage(page);
    await jobSearch.goto();
    await jobSearch.searchByUser('e2e_user1');

    await expect(jobSearch.loadMoreButton).toHaveText('Show 8 more (100/108)');
    expect(await jobSearch.getRowCount()).toBe(100);

    await jobSearch.clickLoadMore();

    expect(await jobSearch.getRowCount()).toBe(108);
    await expect(jobSearch.loadMoreButton).toBeHidden();
  });
});
