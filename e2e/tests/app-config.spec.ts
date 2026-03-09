import { test, expect } from '../fixtures/auth';
import { AppConfigPage } from '../pages/AppConfigPage';

test.describe('App Config Page', () => {
  test('displays configuration form', async ({ page }) => {
    const config = new AppConfigPage(page);
    await config.goto();

    await expect(page.getByText('Connection Profiles', { exact: true })).toBeVisible();
    await expect(page.getByText('Cluster Profiles', { exact: true })).toBeVisible();
    await expect(page.getByText('Secure Password Map', { exact: true })).toBeVisible();
    await expect(config.connectionsJsonInput).toBeVisible();
    await expect(config.clustersJsonInput).toBeVisible();
    await expect(config.passwordsJsonInput).toBeVisible();
    await expect(config.saveButton).toBeVisible();
  });

  test('saves settings successfully', async ({ page }) => {
    const config = new AppConfigPage(page);
    await config.goto();
    await config.save();

    await expect(config.successAlert).toBeVisible({ timeout: 10000 });
  });
});
