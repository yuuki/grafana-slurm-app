#!/usr/bin/env bash
# Tests for deploy-plugin-ssh.sh and deploy-full-ssh.sh. A fake ssh runs the
# remote script locally, with fakes of sudo, systemctl, docker and chown, so the
# tests check that the files land in place, not just the generated commands.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "${TEST_DIR}"' EXIT

# Run the scripts from a copy, so the fake builds do not touch the real dist/.
WORK_DIR="${TEST_DIR}/repo"
mkdir -p "${WORK_DIR}/dev"
cp -R "${ROOT_DIR}/scripts" "${WORK_DIR}/scripts"
cp -R "${ROOT_DIR}/dev/metricsifter_service" "${WORK_DIR}/dev/metricsifter_service"

FAKE_BIN="${TEST_DIR}/bin"
mkdir -p "${FAKE_BIN}"

cat > "${FAKE_BIN}/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p dist
touch dist/module.js
EOF

cat > "${FAKE_BIN}/go" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-o" ]]; then out="$2"; shift; fi
  shift
done
printf 'binary' > "${out}"
EOF

# Answers the passwordless-sudo probe from DEPLOY_TEST_NOPASSWD and runs any
# other `bash -c '<script>'` command locally, logging the stdin's first line.
cat > "${FAKE_BIN}/ssh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
remote="${*: -1}"
if [[ "${remote}" == 'sudo -n true' ]]; then
  echo "probe" >> "${DEPLOY_TEST_LOG}"
  [[ "${DEPLOY_TEST_NOPASSWD}" == "1" ]]
  exit
fi
echo "session" >> "${DEPLOY_TEST_LOG}"
eval "set -- ${remote#bash -c }"
bash -c "$1"
EOF

# Fake sudo: -n succeeds only on NOPASSWD hosts; -S checks the password line.
cat > "${FAKE_BIN}/sudo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
mode="$1"
case "$1" in
  -n)
    shift
    [[ "${DEPLOY_TEST_NOPASSWD}" == "1" ]] || { echo "sudo: a password is required" >&2; exit 1; }
    ;;
  -S)
    shift 3 # -S -p ""
    IFS= read -r password
    [[ "${password}" == "${DEPLOY_TEST_PASSWORD}" ]] || { echo "sudo: incorrect password" >&2; exit 1; }
    ;;
  *)
    if [[ ! -t 0 ]]; then
      echo "sudo: a terminal is required to read the password" >&2
      exit 1
    fi
    ;;
esac
printf "privileged %s %s\n" "${mode}" "$*" >> "${DEPLOY_TEST_LOG}"
exec "$@"
EOF

# GNU tar (CI) does not know bsdtar's --no-mac-metadata; drop it.
REAL_TAR="$(command -v tar)"
cat > "${FAKE_BIN}/tar" <<EOF
#!/usr/bin/env bash
args=()
for arg in "\$@"; do
  [[ "\${arg}" == --no-mac-metadata ]] || args+=("\${arg}")
done
exec "${REAL_TAR}" "\${args[@]}"
EOF

for cmd in systemctl docker chown; do
  printf '%s\n' '#!/usr/bin/env bash' "printf '${cmd} %s\\n' \"\$*\" >> \"\${DEPLOY_TEST_LOG}\"" > "${FAKE_BIN}/${cmd}"
done
chmod +x "${FAKE_BIN}"/*

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# run_deploy <script> <case dir> <1 if sudo needs no password> [VAR=value...]
run_deploy() {
  local script="${1}" case_dir="${2}" nopasswd="${3}"
  shift 3
  mkdir -p "${case_dir}"
  (
    cd "${WORK_DIR}"
    env PATH="${FAKE_BIN}:${PATH}" \
      DEPLOY_TEST_LOG="${case_dir}/log" \
      DEPLOY_TEST_NOPASSWD="${nopasswd}" \
      DEPLOY_TEST_PASSWORD="p'w \$x" \
      DEPLOY_HOST="grafana.example.test" \
      DEPLOY_USER="deployer" \
      REMOTE_PLUGIN_DIR="${case_dir}/plugins dir/yuuki-slurm-app" \
      REMOTE_METRICSIFTER_DIR="${case_dir}/metricsifter" \
      REMOTE_SUDO="1" \
      RESTART_GRAFANA="1" \
      "$@" \
      bash "scripts/${script}" </dev/null >/dev/null
  )
}

assert_plugin_installed() {
  local case_dir="${1}"
  [[ -f "${case_dir}/plugins dir/yuuki-slurm-app/module.js" ]] || fail "${case_dir}: module.js not installed"
  [[ -x "${case_dir}/plugins dir/yuuki-slurm-app/gpx_slurm_app_linux_amd64" ]] || fail "${case_dir}: backend not executable"
  grep -Fq "chown -R grafana:grafana ${case_dir}/plugins dir/yuuki-slurm-app" "${case_dir}/log" || fail "${case_dir}: no chown"
  grep -Fq 'systemctl restart grafana-server' "${case_dir}/log" || fail "${case_dir}: no restart"
}

for script in deploy-plugin-ssh.sh deploy-full-ssh.sh; do
  # Passwordless sudo.
  case_dir="${TEST_DIR}/${script}/nopasswd"
  run_deploy "${script}" "${case_dir}" 1 || fail "${script}: NOPASSWD deploy failed"
  assert_plugin_installed "${case_dir}"
  grep -Fq 'privileged -n systemctl restart grafana-server' "${case_dir}/log" || fail "${script}: restart not via sudo -n"

  # sudo needs a password: it travels ahead of the archive on stdin.
  case_dir="${TEST_DIR}/${script}/password"
  run_deploy "${script}" "${case_dir}" 0 DEPLOY_SUDO_PASSWORD="p'w \$x" || fail "${script}: password deploy failed"
  assert_plugin_installed "${case_dir}"
  grep -Fq 'privileged -S systemctl restart grafana-server' "${case_dir}/log" || fail "${script}: restart not via sudo -S"

  # A wrong password stops the deploy before anything is installed.
  case_dir="${TEST_DIR}/${script}/wrong-password"
  if run_deploy "${script}" "${case_dir}" 0 DEPLOY_SUDO_PASSWORD="wrong" 2>/dev/null; then
    fail "${script}: deploy succeeded with a wrong password"
  fi
  [[ ! -e "${case_dir}/plugins dir" ]] || fail "${script}: installed with a wrong password"

  # No sudo at all.
  case_dir="${TEST_DIR}/${script}/no-sudo"
  run_deploy "${script}" "${case_dir}" 0 REMOTE_SUDO=0 || fail "${script}: REMOTE_SUDO=0 deploy failed"
  assert_plugin_installed "${case_dir}"
  if grep -Fq 'probe' "${case_dir}/log"; then fail "${script}: probed sudo with REMOTE_SUDO=0"; fi
  if grep -Fq 'privileged' "${case_dir}/log"; then fail "${script}: used sudo with REMOTE_SUDO=0"; fi

  # sudo needs a password but there is neither DEPLOY_SUDO_PASSWORD nor a
  # terminal (CI has no controlling terminal; skipped when run from one).
  if ! { true </dev/tty; } 2>/dev/null; then
    case_dir="${TEST_DIR}/${script}/no-tty"
    if run_deploy "${script}" "${case_dir}" 0 2>/dev/null; then
      fail "${script}: deploy succeeded without a password or terminal"
    fi
    if grep -Fq 'session' "${case_dir}/log"; then fail "${script}: reached ssh without a password"; fi
  fi
done

# The full deploy installs the sidecar and starts its container.
for mode in nopasswd password; do
  case_dir="${TEST_DIR}/deploy-full-ssh.sh/${mode}"
  [[ -f "${case_dir}/metricsifter/Dockerfile" ]] || fail "full/${mode}: sidecar not installed"
  grep -Fq 'docker build -t yuuki-slurm-app-metricsifter' "${case_dir}/log" || fail "full/${mode}: no docker build"
  grep -Fq 'docker run -d --name yuuki-slurm-app-metricsifter --restart unless-stopped -p 127.0.0.1:18000:8000 yuuki-slurm-app-metricsifter' \
    "${case_dir}/log" || fail "full/${mode}: no docker run"
done

echo 'deploy-ssh.test.sh: pass'
