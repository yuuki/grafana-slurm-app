#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/remote-sudo.sh
source "${SCRIPT_DIR}/lib/remote-sudo.sh"

PLUGIN_ID="yuuki-slurm-app"
TARGET_OS="${TARGET_OS:-linux}"
TARGET_ARCH="${TARGET_ARCH:-amd64}"
BACKEND_BIN="gpx_slurm_app_${TARGET_OS}_${TARGET_ARCH}"
DEPLOY_HOST="${DEPLOY_HOST:-}"
DEPLOY_USER="${DEPLOY_USER:-}"
DEPLOY_PORT="${DEPLOY_PORT:-}"
REMOTE_PLUGIN_DIR="${REMOTE_PLUGIN_DIR:-/var/lib/grafana/plugins/${PLUGIN_ID}}"
REMOTE_METRICSIFTER_DIR="${REMOTE_METRICSIFTER_DIR:-/opt/${PLUGIN_ID}/metricsifter}"
PLUGIN_OWNER="${PLUGIN_OWNER:-grafana:grafana}"
REMOTE_SUDO="${REMOTE_SUDO:-0}"
RESTART_GRAFANA="${RESTART_GRAFANA:-0}"
GRAFANA_SERVICE="${GRAFANA_SERVICE:-grafana-server}"
METRICSIFTER_IMAGE_NAME="${METRICSIFTER_IMAGE_NAME:-${PLUGIN_ID}-metricsifter}"
METRICSIFTER_CONTAINER_NAME="${METRICSIFTER_CONTAINER_NAME:-${PLUGIN_ID}-metricsifter}"
METRICSIFTER_BIND_HOST="${METRICSIFTER_BIND_HOST:-127.0.0.1}"
METRICSIFTER_PORT="${METRICSIFTER_PORT:-18000}"
METRICSIFTER_RESTART_POLICY="${METRICSIFTER_RESTART_POLICY:-unless-stopped}"
METRICSIFTER_GRAFANA_URL="${METRICSIFTER_GRAFANA_URL:-http://127.0.0.1:${METRICSIFTER_PORT}}"

if [[ -z "${DEPLOY_HOST}" ]]; then
  echo "DEPLOY_HOST is required" >&2
  exit 1
fi

SSH_TARGET="${DEPLOY_HOST}"
if [[ -n "${DEPLOY_USER}" ]]; then
  SSH_TARGET="${DEPLOY_USER}@${DEPLOY_HOST}"
fi

# Used by lib/remote-sudo.sh.
# shellcheck disable=SC2034
SSH_PORT_ARGS=()
if [[ -n "${DEPLOY_PORT}" ]]; then
  # shellcheck disable=SC2034
  SSH_PORT_ARGS=(-p "${DEPLOY_PORT}")
fi

# Ask for the sudo password (if needed) before the build, not after it.
remote_sudo_init

npm run build
GOOS="${TARGET_OS}" GOARCH="${TARGET_ARCH}" go build -o "dist/${BACKEND_BIN}" ./pkg

REMOTE_PLUGIN_DIR_Q="$(quote_remote "${REMOTE_PLUGIN_DIR}")"
PLUGIN_SCRIPT="$(remote_install_script "${REMOTE_PLUGIN_DIR}")"
PLUGIN_SCRIPT+=$'\n'"run chown -R $(quote_remote "${PLUGIN_OWNER}") ${REMOTE_PLUGIN_DIR_Q}"
PLUGIN_SCRIPT+=$'\n'"run chmod -R a+rX ${REMOTE_PLUGIN_DIR_Q}"
PLUGIN_SCRIPT+=$'\n'"run chmod +x $(quote_remote "${REMOTE_PLUGIN_DIR}/${BACKEND_BIN}")"

COPYFILE_DISABLE=1 tar -C dist -cf - . | ssh_remote "${PLUGIN_SCRIPT}"

REMOTE_METRICSIFTER_DIR_Q="$(quote_remote "${REMOTE_METRICSIFTER_DIR}")"
METRICSIFTER_IMAGE_NAME_Q="$(quote_remote "${METRICSIFTER_IMAGE_NAME}")"
METRICSIFTER_CONTAINER_NAME_Q="$(quote_remote "${METRICSIFTER_CONTAINER_NAME}")"
SIDECAR_SCRIPT="run rm -rf ${REMOTE_METRICSIFTER_DIR_Q}"
SIDECAR_SCRIPT+=$'\n'"$(remote_install_script "${REMOTE_METRICSIFTER_DIR}")"
SIDECAR_SCRIPT+=$'\n'"run docker build -t ${METRICSIFTER_IMAGE_NAME_Q} ${REMOTE_METRICSIFTER_DIR_Q}"
SIDECAR_SCRIPT+=$'\n'"run docker rm -f ${METRICSIFTER_CONTAINER_NAME_Q} >/dev/null 2>&1 || true"
SIDECAR_SCRIPT+=$'\n'"run docker run -d --name ${METRICSIFTER_CONTAINER_NAME_Q}"
SIDECAR_SCRIPT+=" --restart $(quote_remote "${METRICSIFTER_RESTART_POLICY}")"
SIDECAR_SCRIPT+=" -p $(quote_remote "${METRICSIFTER_BIND_HOST}:${METRICSIFTER_PORT}:8000")"
SIDECAR_SCRIPT+=" ${METRICSIFTER_IMAGE_NAME_Q} >/dev/null"
# Restart in the same session as the sidecar, so no extra session is needed.
if [[ "${RESTART_GRAFANA}" == "1" ]]; then
  SIDECAR_SCRIPT+=$'\n'"run systemctl restart $(quote_remote "${GRAFANA_SERVICE}")"
fi

COPYFILE_DISABLE=1 tar -C dev/metricsifter_service -cf - . | ssh_remote "${SIDECAR_SCRIPT}"

cat <<EOF
Full deployment completed on ${SSH_TARGET}

Plugin:
- Directory: ${REMOTE_PLUGIN_DIR}

MetricSifter:
- Source directory: ${REMOTE_METRICSIFTER_DIR}
- Docker image: ${METRICSIFTER_IMAGE_NAME}
- Container: ${METRICSIFTER_CONTAINER_NAME}
- Recommended Grafana URL: ${METRICSIFTER_GRAFANA_URL}

Next steps:
1. Ensure Grafana allows unsigned plugins: GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=${PLUGIN_ID}
2. Set the plugin configuration field "MetricSifter Service URL" to ${METRICSIFTER_GRAFANA_URL}
3. Restart Grafana if you did not set RESTART_GRAFANA=1
4. Verify the sidecar on the remote host: docker ps | grep ${METRICSIFTER_CONTAINER_NAME}
EOF
