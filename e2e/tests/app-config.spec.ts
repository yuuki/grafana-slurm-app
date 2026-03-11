import { test, expect } from '../fixtures/auth';
import { AppConfigPage } from '../pages/AppConfigPage';

test.describe('App Config Page', () => {
  test('displays configuration form', async ({ page }) => {
    const config = new AppConfigPage(page);
    await config.goto();

    await expect(config.connectionFieldset).toBeVisible();
    await expect(config.clusterFieldset).toBeVisible();
    await expect(config.addConnectionButton).toBeVisible();
    await expect(config.addClusterButton).toBeVisible();
    await expect(config.saveButton).toBeVisible();
  });

  test('saves settings successfully', async ({ page }) => {
    const config = new AppConfigPage(page);
    await config.goto();
    await config.save();

    await expect(config.successAlert).toBeVisible({ timeout: 10000 });
  });
});
