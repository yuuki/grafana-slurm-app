#!/usr/bin/env bash

set -euo pipefail

PLUGIN_ID="yuuki-slurm-app"
TARGET_OS="${TARGET_OS:-linux}"
TARGET_ARCH="${TARGET_ARCH:-amd64}"
BACKEND_BIN="gpx_slurm_app_${TARGET_OS}_${TARGET_ARCH}"
DEPLOY_HOST="${DEPLOY_HOST:-}"
DEPLOY_USER="${DEPLOY_USER:-}"
DEPLOY_PORT="${DEPLOY_PORT:-}"
REMOTE_PLUGIN_DIR="${REMOTE_PLUGIN_DIR:-/var/lib/grafana/plugins/${PLUGIN_ID}}"
PLUGIN_OWNER="${PLUGIN_OWNER:-grafana:grafana}"
REMOTE_SUDO="${REMOTE_SUDO:-0}"
RESTART_GRAFANA="${RESTART_GRAFANA:-0}"
GRAFANA_SERVICE="${GRAFANA_SERVICE:-grafana-server}"

if [[ -z "${DEPLOY_HOST}" ]]; then
  echo "DEPLOY_HOST is required" >&2
  exit 1
fi

SSH_TARGET="${DEPLOY_HOST}"
if [[ -n "${DEPLOY_USER}" ]]; then
  SSH_TARGET="${DEPLOY_USER}@${DEPLOY_HOST}"
fi

if [[ "${REMOTE_SUDO}" == "1" ]]; then
  REMOTE_PREFIX="sudo"
else
  REMOTE_PREFIX=""
fi

SSH_PORT_ARGS=()
if [[ -n "${DEPLOY_PORT}" ]]; then
  SSH_PORT_ARGS=(-p "${DEPLOY_PORT}")
fi

npm run build
GOOS="${TARGET_OS}" GOARCH="${TARGET_ARCH}" go build -o "dist/${BACKEND_BIN}" ./pkg

COPYFILE_DISABLE=1 tar -C dist -cf - . | ssh "${SSH_PORT_ARGS[@]}" "${SSH_TARGET}" "\
  set -euo pipefail
  ${REMOTE_PREFIX} mkdir -p '${REMOTE_PLUGIN_DIR}'
  ${REMOTE_PREFIX} tar -C '${REMOTE_PLUGIN_DIR}' -xf -
  ${REMOTE_PREFIX} chown -R '${PLUGIN_OWNER}' '${REMOTE_PLUGIN_DIR}'
  ${REMOTE_PREFIX} chmod +x '${REMOTE_PLUGIN_DIR}/${BACKEND_BIN}'
"

if [[ "${RESTART_GRAFANA}" == "1" ]]; then
  ssh "${SSH_PORT_ARGS[@]}" "${SSH_TARGET}" "\
    set -euo pipefail
    ${REMOTE_PREFIX} systemctl restart '${GRAFANA_SERVICE}'
  "
fi

cat <<EOF
Deployed ${PLUGIN_ID} to ${SSH_TARGET}:${REMOTE_PLUGIN_DIR}

Next steps:
1. Ensure Grafana allows unsigned plugins: GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=${PLUGIN_ID}
2. Restart Grafana if you did not set RESTART_GRAFANA=1
EOF
