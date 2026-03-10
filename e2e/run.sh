#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILES="-f docker-compose.yaml -f docker-compose.e2e.yaml"

cleanup() {
  echo "Stopping containers..."
  docker compose $COMPOSE_FILES down -v
}

trap cleanup EXIT

echo "==> Stopping any existing dev containers..."
docker compose down 2>/dev/null || true

echo "==> Building frontend..."
npm run build

echo "==> Building backend..."
GOOS=linux GOARCH=amd64 go build -o dist/gpx_slurm_app_linux_amd64 ./pkg
chmod +x dist/gpx_slurm_app_linux_amd64

echo "==> Starting containers..."
docker compose $COMPOSE_FILES up -d --wait

if [ -z "${GRAFANA_URL:-}" ]; then
  echo "==> Resolving Grafana host port..."
  GRAFANA_PORT="${GRAFANA_PORT:-$(docker compose $COMPOSE_FILES port grafana 3000 | sed -E 's/.*:([0-9]+)$/\1/')}"
  export GRAFANA_PORT
  export GRAFANA_URL="http://127.0.0.1:${GRAFANA_PORT}"
fi

echo "==> Waiting for Grafana to be ready..."
until curl -sf "${GRAFANA_URL}/api/health" > /dev/null 2>&1; do
  sleep 2
done

echo "==> Running E2E tests..."
npx playwright test "$@"
