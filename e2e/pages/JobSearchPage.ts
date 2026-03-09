import { Page, Locator } from '@playwright/test';

export class JobSearchPage {
  static readonly clusterId = 'gpu_cluster';
  readonly page: Page;
  readonly clusterSelect: Locator;
  readonly jobIdInput: Locator;
  readonly nameInput: Locator;
  readonly userInput: Locator;
  readonly accountInput: Locator;
  readonly partitionInput: Locator;
  readonly searchButton: Locator;
  readonly jobTable: Locator;
  readonly tableHeaders: Locator;
  readonly tableRows: Locator;
  readonly noJobsMessage: Locator;
  readonly loadingIndicator: Locator;

  constructor(page: Page) {
    this.page = page;
    this.clusterSelect = page.getByLabel('Cluster');
    this.jobIdInput = page.getByPlaceholder('Direct lookup...');
    this.nameInput = page.getByPlaceholder('Search...');
    this.userInput = page.getByPlaceholder('Username');
    this.accountInput = page.getByPlaceholder('Account');
    this.partitionInput = page.getByPlaceholder('Partition');
    this.searchButton = page.locator('form button[type="submit"]');
    this.jobTable = page.locator('table');
    this.tableHeaders = page.locator('table thead th');
    this.tableRows = page.locator('table tbody tr');
    this.noJobsMessage = page.getByText('No jobs found.');
    this.loadingIndicator = page.getByText('Loading jobs...');
  }

  async goto() {
    await this.page.goto('/a/yuuki-slurm-app/jobs');
    await this.waitForLoad();
  }

  async waitForLoad() {
    await this.page.waitForLoadState('networkidle');
    await Promise.race([
      this.tableRows.first().waitFor({ state: 'visible', timeout: 10000 }),
      this.noJobsMessage.waitFor({ state: 'visible', timeout: 10000 }),
      this.loadingIndicator.waitFor({ state: 'hidden', timeout: 10000 }),
    ]);
  }

  async searchByUser(user: string) {
    await this.userInput.fill(user);
    await this.searchButton.click();
    await this.waitForLoad();
  }

  async searchByName(name: string) {
    await this.nameInput.fill(name);
    await this.searchButton.click();
    await this.waitForLoad();
  }

  async searchByPartition(partition: string) {
    await this.partitionInput.fill(partition);
    await this.searchButton.click();
    await this.waitForLoad();
  }

  async searchByJobId(jobId: string) {
    await this.jobIdInput.fill(jobId);
    await this.searchButton.click();
  }

  async clickJobRow(jobId: string) {
    await this.page.locator(`table tbody tr`).filter({ hasText: jobId }).click();
  }

  async getRowCount(): Promise<number> {
    return this.tableRows.count();
  }
}
