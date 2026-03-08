#!/usr/bin/env bash

set -euo pipefail

PLUGIN_ID="yuuki-slurm-app"
PLUGIN_DIR="${1:-/var/lib/grafana/plugins/${PLUGIN_ID}}"
TARGET_OS="${TARGET_OS:-linux}"
TARGET_ARCH="${TARGET_ARCH:-amd64}"
BACKEND_BIN="gpx_slurm_app_${TARGET_OS}_${TARGET_ARCH}"

npm run build
GOOS="${TARGET_OS}" GOARCH="${TARGET_ARCH}" go build -o "dist/${BACKEND_BIN}" ./pkg

mkdir -p "${PLUGIN_DIR}"
cp -R dist/. "${PLUGIN_DIR}/"
chmod +x "${PLUGIN_DIR}/${BACKEND_BIN}"

cat <<EOF
Installed ${PLUGIN_ID} to ${PLUGIN_DIR}

Next steps:
1. Allow unsigned plugins in Grafana: GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=${PLUGIN_ID}
2. Restart Grafana
EOF
