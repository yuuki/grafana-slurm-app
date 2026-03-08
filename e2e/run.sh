#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILES="-f docker-compose.yaml -f docker-compose.e2e.yaml"
export GRAFANA_PORT="${GRAFANA_PORT:-3001}"
GRAFANA_URL="${GRAFANA_URL:-http://localhost:${GRAFANA_PORT}}"

cleanup() {
  echo "Stopping containers..."
  docker compose $COMPOSE_FILES down -v
}

trap cleanup EXIT

echo "==> Stopping any existing dev containers..."
docker compose down 2>/dev/null || true

echo "==> Building frontend..."
npm run build

echo "==> Starting containers..."
docker compose $COMPOSE_FILES up -d --wait

echo "==> Waiting for Grafana to be ready..."
until curl -sf "${GRAFANA_URL}/api/health" > /dev/null 2>&1; do
  sleep 2
done

echo "==> Running E2E tests..."
npx playwright test "$@"
