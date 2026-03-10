#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PROM_DATA_DIR="$SCRIPT_DIR/prometheus-data"

cd "$PROJECT_DIR"

echo "==> Generating metrics data..."
python3 dev/generate-metrics.py

echo "==> Creating Prometheus TSDB blocks from backfill data..."
rm -rf "$PROM_DATA_DIR"
mkdir -p "$PROM_DATA_DIR"

docker run --rm \
  -v "$SCRIPT_DIR/metrics-backfill.om:/data/metrics.om:ro" \
  -v "$PROM_DATA_DIR:/output" \
  --entrypoint promtool \
  prom/prometheus:latest \
  tsdb create-blocks-from openmetrics /data/metrics.om /output

echo "==> Building frontend..."
npm run build 2>/dev/null || echo "WARN: frontend build skipped (run 'npm run build' separately if needed)"

echo "==> Starting docker compose..."
docker compose up -d --wait

echo "==> Waiting for Grafana to be ready..."
GRAFANA_URL="${GRAFANA_URL:-http://localhost:${GRAFANA_PORT:-3000}}"
until curl -sf "${GRAFANA_URL}/api/health" > /dev/null 2>&1; do
  sleep 2
done

echo "==> Dev environment ready!"
echo "    Grafana:    ${GRAFANA_URL}"
echo "    Prometheus: http://localhost:9090"
echo "    MySQL:      localhost:3306 (slurm/slurm)"
