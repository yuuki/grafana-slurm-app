import { Page, Locator } from '@playwright/test';

export class AppConfigPage {
  readonly page: Page;
  readonly connectionFieldset: Locator;
  readonly clusterFieldset: Locator;
  readonly addConnectionButton: Locator;
  readonly addClusterButton: Locator;
  readonly saveButton: Locator;
  readonly successAlert: Locator;
  readonly errorAlert: Locator;

  constructor(page: Page) {
    this.page = page;
    this.connectionFieldset = page.getByText('Connection Profiles', { exact: true });
    this.clusterFieldset = page.getByText('Cluster Profiles', { exact: true });
    this.addConnectionButton = page.getByRole('button', { name: 'Add Connection' });
    this.addClusterButton = page.getByRole('button', { name: 'Add Cluster' });
    this.saveButton = page.getByRole('button', { name: 'Save settings' });
    this.successAlert = page.getByText('Settings saved successfully.');
    this.errorAlert = page.locator('[data-testid="data-testid Alert error"]');
  }

  async goto() {
    await this.page.goto('/plugins/yuuki-slurm-app');
    await this.page.waitForLoadState('networkidle');
  }

  async save() {
    await this.saveButton.click();
  }
}
