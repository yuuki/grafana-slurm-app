import { Page, Locator } from '@playwright/test';

export class JobDashboardPage {
  static readonly clusterId = 'gpu_cluster';
  readonly page: Page;
  readonly errorAlert: Locator;
  readonly loadingIndicator: Locator;
  readonly metadataTitle: Locator;
  readonly metricExplorerTitle: Locator;
  readonly recommendedViewsTitle: Locator;

  constructor(page: Page) {
    this.page = page;
    this.errorAlert = page.locator('[data-testid="data-testid Alert error"]');
    this.loadingIndicator = page.getByText(/Loading job/);
    this.metadataTitle = page.getByText('Job metadata', { exact: true });
    this.metricExplorerTitle = page.getByText('Metric Explorer', { exact: true });
    this.recommendedViewsTitle = page.getByText('Recommended views', { exact: true });
  }

  async goto(jobId: string) {
    await this.page.goto(`/a/yuuki-slurm-app/jobs/${JobDashboardPage.clusterId}/${jobId}`);
    await this.page.waitForLoadState('networkidle');
  }

  async hasMetadataSection(): Promise<boolean> {
    return this.metadataTitle.isVisible({ timeout: 5000 }).catch(() => false);
  }

  async hasMetricExplorerSection(): Promise<boolean> {
    return this.metricExplorerTitle.isVisible({ timeout: 5000 }).catch(() => false);
  }

  async hasRecommendedViewsSection(): Promise<boolean> {
    return this.recommendedViewsTitle.isVisible({ timeout: 5000 }).catch(() => false);
  }

  async hasMetadataCard(label: string): Promise<boolean> {
    return this.page.getByText(label, { exact: true }).isVisible({ timeout: 5000 }).catch(() => false);
  }

  async hasError(): Promise<boolean> {
    return this.errorAlert.isVisible({ timeout: 5000 }).catch(() => false);
  }
}
