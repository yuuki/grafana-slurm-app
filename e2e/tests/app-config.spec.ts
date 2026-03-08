import { test, expect } from '../fixtures/auth';
import { AppConfigPage } from '../pages/AppConfigPage';

test.describe('App Config Page', () => {
  test('displays configuration form', async ({ page }) => {
    const config = new AppConfigPage(page);
    await config.goto();

    await expect(page.getByText('Slurmdbd Database Connection')).toBeVisible();
    await expect(page.getByText('Metrics Settings')).toBeVisible();
    await expect(config.dbHostInput).toBeVisible();
    await expect(config.dbNameInput).toBeVisible();
    await expect(config.dbUserInput).toBeVisible();
    await expect(config.clusterNameInput).toBeVisible();
    await expect(config.promDatasourceUidInput).toBeVisible();
    await expect(config.saveButton).toBeVisible();
  });

  test('saves settings successfully', async ({ page }) => {
    const config = new AppConfigPage(page);
    await config.goto();

    await config.fillDbHost('mysql:3306');
    await config.fillDbUser('slurm');
    await config.fillClusterName('gpu_cluster');
    await config.save();

    await expect(config.successAlert).toBeVisible({ timeout: 10000 });
  });
});
