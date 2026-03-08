import { Page, Locator } from '@playwright/test';

export class JobDashboardPage {
  readonly page: Page;
  readonly errorAlert: Locator;
  readonly loadingIndicator: Locator;

  constructor(page: Page) {
    this.page = page;
    this.errorAlert = page.locator('[data-testid="data-testid Alert error"]');
    this.loadingIndicator = page.getByText(/Loading job/);
  }

  async goto(jobId: string) {
    await this.page.goto(`/a/yuuki-slurm-app/job/${jobId}`);
    await this.page.waitForLoadState('networkidle');
  }

  async hasOverviewSection(): Promise<boolean> {
    return this.page.getByText('Overview').isVisible({ timeout: 5000 }).catch(() => false);
  }

  async hasGpuSection(): Promise<boolean> {
    return this.page.getByText('GPU Metrics').isVisible({ timeout: 5000 }).catch(() => false);
  }

  async hasCpuMemorySection(): Promise<boolean> {
    return this.page.getByText('CPU / Memory').isVisible({ timeout: 5000 }).catch(() => false);
  }

  async hasNetworkSection(): Promise<boolean> {
    return this.page.getByText('Network').isVisible({ timeout: 5000 }).catch(() => false);
  }

  async hasDiskSection(): Promise<boolean> {
    return this.page.getByText('Disk I/O').isVisible({ timeout: 5000 }).catch(() => false);
  }

  async hasError(): Promise<boolean> {
    return this.errorAlert.isVisible({ timeout: 5000 }).catch(() => false);
  }
}
