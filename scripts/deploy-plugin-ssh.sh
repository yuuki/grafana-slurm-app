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
REMOTE_SCRIPT="$(remote_install_script "${REMOTE_PLUGIN_DIR}")"
REMOTE_SCRIPT+=$'\n'"run chown -R $(quote_remote "${PLUGIN_OWNER}") ${REMOTE_PLUGIN_DIR_Q}"
REMOTE_SCRIPT+=$'\n'"run chmod -R a+rX ${REMOTE_PLUGIN_DIR_Q}"
REMOTE_SCRIPT+=$'\n'"run chmod +x $(quote_remote "${REMOTE_PLUGIN_DIR}/${BACKEND_BIN}")"
# Restart in the same session, so the password is sent once per run.
if [[ "${RESTART_GRAFANA}" == "1" ]]; then
  REMOTE_SCRIPT+=$'\n'"run systemctl restart $(quote_remote "${GRAFANA_SERVICE}")"
fi

# --no-mac-metadata: don't embed macOS xattrs (e.g. com.apple.provenance) in the
# archive, otherwise the remote tar warns "Ignoring unknown extended header keyword".
COPYFILE_DISABLE=1 tar -C dist --no-mac-metadata -cf - . | ssh_remote "${REMOTE_SCRIPT}"

cat <<EOF
Deployed ${PLUGIN_ID} to ${SSH_TARGET}:${REMOTE_PLUGIN_DIR}

Next steps:
1. Ensure Grafana allows unsigned plugins: GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=${PLUGIN_ID}
2. Restart Grafana if you did not set RESTART_GRAFANA=1
EOF
