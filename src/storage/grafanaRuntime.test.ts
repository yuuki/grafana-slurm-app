import fs from 'fs';
import path from 'path';

describe('grafana runtime configuration', () => {
  const repoRoot = path.resolve(__dirname, '../..');

  it('uses environment-driven Playwright base URL instead of hardcoded localhost:3001', () => {
    const configPath = path.join(repoRoot, 'playwright.config.ts');
    const config = fs.readFileSync(configPath, 'utf8');

    expect(config).not.toContain('http://localhost:3001');
    expect(config).toContain('GRAFANA_URL');
  });

  it('can discover the mapped Grafana port from docker compose in Playwright config', () => {
    const configPath = path.join(repoRoot, 'playwright.config.ts');
    const config = fs.readFileSync(configPath, 'utf8');

    expect(config).toContain('docker compose -f docker-compose.yaml -f docker-compose.e2e.yaml port grafana 3000');
  });

  it('discovers the mapped Grafana port from docker compose in the E2E runner', () => {
    const runnerPath = path.join(repoRoot, 'e2e/run.sh');
    const runner = fs.readFileSync(runnerPath, 'utf8');

    expect(runner).toContain('docker compose $COMPOSE_FILES port grafana 3000');
    expect(runner).toContain('GRAFANA_URL="http://127.0.0.1:${GRAFANA_PORT}"');
  });
});
