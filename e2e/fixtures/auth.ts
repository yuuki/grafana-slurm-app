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

    await page.waitForLoadState('networkidle');

    // Grafana may force the default password update screen on first login.
    // isVisible() does not wait, so use click() with a timeout to give the
    // prompt a chance to render before deciding it is absent.
    try {
      await page.getByRole('button', { name: 'Skip' }).click({ timeout: 5000 });
      await page.waitForLoadState('networkidle');
    } catch {
      // no password-update prompt appeared
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
