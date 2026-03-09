import { test as base, expect, request, APIRequestContext } from '@playwright/test';

const GRAFANA_USER = process.env.GRAFANA_USER || 'admin';
const GRAFANA_PASS = process.env.GRAFANA_PASS || 'admin';

type AuthFixtures = {
  authenticatedRequest: APIRequestContext;
};

export const test = base.extend<AuthFixtures>({
  page: async ({ page }, use) => {
    await page.goto('/login');
    await page.getByLabel('Email or username').fill(GRAFANA_USER);
    await page.getByTestId('data-testid Password input field').fill(GRAFANA_PASS);
    await page.getByRole('button', { name: /log in/i }).click();

    const skipButton = page.getByRole('button', { name: 'Skip' });
    await page.waitForLoadState('networkidle');

    // Grafana may force the default password update screen on first login.
    if (await skipButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await skipButton.click();
      await page.waitForLoadState('networkidle');
    }

    await page.waitForURL((url: URL) => !url.pathname.includes('/login') && !url.pathname.includes('/password'));
    await use(page);
  },

  authenticatedRequest: async ({ baseURL }, use) => {
    const ctx = await request.newContext({
      baseURL: baseURL!,
      extraHTTPHeaders: {
        Authorization: `Basic ${Buffer.from(`${GRAFANA_USER}:${GRAFANA_PASS}`).toString('base64')}`,
      },
    });
    await use(ctx);
    await ctx.dispose();
  },
});

export { expect };
