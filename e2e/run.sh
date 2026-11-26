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

# Grafana loads gpx_slurm_app_linux_<GOARCH> for the architecture its container runs on.
DOCKER_ARCH="$(docker info --format '{{.Architecture}}')"
case "$DOCKER_ARCH" in
  x86_64 | amd64) BACKEND_ARCH=amd64 ;;
  aarch64 | arm64) BACKEND_ARCH=arm64 ;;
  *)
    echo "Unsupported Docker architecture: ${DOCKER_ARCH}" >&2
    exit 1
    ;;
esac

echo "==> Building backend for linux/${BACKEND_ARCH}..."
GOOS=linux GOARCH="$BACKEND_ARCH" go build -o "dist/gpx_slurm_app_linux_${BACKEND_ARCH}" ./pkg
chmod +x "dist/gpx_slurm_app_linux_${BACKEND_ARCH}"

echo "==> Preparing Prometheus data directory..."
rm -rf dev/prometheus-data
mkdir -p dev/prometheus-data
chmod 0777 dev/prometheus-data

echo "==> Starting containers..."
docker compose $COMPOSE_FILES up -d --wait

if [ -z "${GRAFANA_URL:-}" ]; then
  echo "==> Resolving Grafana host port..."
  GRAFANA_PORT="${GRAFANA_PORT:-$(docker compose $COMPOSE_FILES port grafana 3000 | sed -E 's/.*:([0-9]+)$/\1/')}"
  export GRAFANA_PORT
  export GRAFANA_URL="http://127.0.0.1:${GRAFANA_PORT}"
fi

echo "==> Waiting for Grafana to be ready..."
HEALTH_DEADLINE=$((SECONDS + 120))
until curl -sf "${GRAFANA_URL}/api/health" > /dev/null 2>&1; do
  if [ "$SECONDS" -ge "$HEALTH_DEADLINE" ]; then
    echo "Grafana was not ready within 120 seconds. Last Grafana logs:" >&2
    docker compose $COMPOSE_FILES logs --tail 50 grafana >&2 || true
    exit 1
  fi
  sleep 2
done

echo "==> Running E2E tests..."
npx playwright test "$@"
