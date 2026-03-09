import { Page, Locator } from '@playwright/test';

export class AppConfigPage {
  readonly page: Page;
  readonly connectionsJsonInput: Locator;
  readonly clustersJsonInput: Locator;
  readonly passwordsJsonInput: Locator;
  readonly saveButton: Locator;
  readonly successAlert: Locator;
  readonly errorAlert: Locator;

  constructor(page: Page) {
    this.page = page;
    this.connectionsJsonInput = page.locator('textarea').nth(0);
    this.clustersJsonInput = page.locator('textarea').nth(1);
    this.passwordsJsonInput = page.locator('textarea').nth(2);
    this.saveButton = page.getByRole('button', { name: 'Save settings' });
    this.successAlert = page.getByText('Settings saved successfully.');
    this.errorAlert = page.locator('[data-testid="data-testid Alert error"]');
  }

  async goto() {
    await this.page.goto('/plugins/yuuki-slurm-app');
    await this.page.waitForLoadState('networkidle');
  }

  async fillConnectionsJson(value: string) {
    await this.connectionsJsonInput.fill(value);
  }

  async fillClustersJson(value: string) {
    await this.clustersJsonInput.fill(value);
  }

  async save() {
    await this.saveButton.click();
  }
}
