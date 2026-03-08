import { Page, Locator } from '@playwright/test';

export class JobSearchPage {
  readonly page: Page;
  readonly jobIdInput: Locator;
  readonly nameInput: Locator;
  readonly userInput: Locator;
  readonly partitionInput: Locator;
  readonly searchButton: Locator;
  readonly jobTable: Locator;
  readonly tableHeaders: Locator;
  readonly tableRows: Locator;
  readonly noJobsMessage: Locator;
  readonly loadingIndicator: Locator;

  constructor(page: Page) {
    this.page = page;
    this.jobIdInput = page.getByPlaceholder('Direct lookup...');
    this.nameInput = page.getByPlaceholder('Search...');
    this.userInput = page.getByPlaceholder('Username');
    this.partitionInput = page.getByPlaceholder('Partition');
    this.searchButton = page.getByRole('button', { name: 'Search' });
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
    await this.page.waitForResponse(
      (resp) => resp.url().includes('/resources/api/jobs') && resp.status() === 200
    );
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
