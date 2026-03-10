import { execSync } from 'node:child_process';
import { defineConfig, devices } from '@playwright/test';

function resolveGrafanaUrl(): string {
  if (process.env.GRAFANA_URL) {
    return process.env.GRAFANA_URL;
  }

  if (process.env.GRAFANA_PORT) {
    return `http://127.0.0.1:${process.env.GRAFANA_PORT}`;
  }

  try {
    const portMapping = execSync(
      'docker compose -f docker-compose.yaml -f docker-compose.e2e.yaml port grafana 3000',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    const matchedPort = portMapping.match(/:(\d+)$/);

    if (matchedPort) {
      return `http://127.0.0.1:${matchedPort[1]}`;
    }
  } catch {
    // Fall back to the default dev port when Docker is not running.
  }

  return 'http://127.0.0.1:3000';
}

const grafanaUrl = resolveGrafanaUrl();

export default defineConfig({
  testDir: './e2e/tests',
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  use: {
    baseURL: grafanaUrl,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
