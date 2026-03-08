import { Page, Locator } from '@playwright/test';

export class AppConfigPage {
  readonly page: Page;
  readonly dbHostInput: Locator;
  readonly dbNameInput: Locator;
  readonly dbUserInput: Locator;
  readonly clusterNameInput: Locator;
  readonly promDatasourceUidInput: Locator;
  readonly saveButton: Locator;
  readonly successAlert: Locator;
  readonly errorAlert: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dbHostInput = page.getByPlaceholder('localhost:3306');
    this.dbNameInput = page.getByPlaceholder('slurm_acct_db');
    this.dbUserInput = page.getByPlaceholder('slurm');
    this.clusterNameInput = page.getByPlaceholder('gpu-cluster');
    this.promDatasourceUidInput = page.getByPlaceholder('prometheus');
    this.saveButton = page.getByRole('button', { name: 'Save settings' });
    this.successAlert = page.getByText('Settings saved successfully.');
    this.errorAlert = page.locator('[data-testid="data-testid Alert error"]');
  }

  async goto() {
    await this.page.goto('/plugins/yuuki-slurm-app');
    await this.page.waitForLoadState('networkidle');
  }

  async fillDbHost(host: string) {
    await this.dbHostInput.fill(host);
  }

  async fillDbUser(user: string) {
    await this.dbUserInput.fill(user);
  }

  async fillClusterName(name: string) {
    await this.clusterNameInput.fill(name);
  }

  async save() {
    await this.saveButton.click();
  }
}
