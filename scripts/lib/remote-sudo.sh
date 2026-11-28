# shellcheck shell=bash
# Helpers for the SSH deploy scripts: run a script on the remote host, with
# `sudo` when REMOTE_SUDO=1, while the SSH session's stdin carries an archive.
#
# Because stdin carries the archive, a remote sudo cannot prompt for its
# password there ("sudo: a terminal is required to read the password").
# remote_sudo_init asks for the password locally when the remote sudo needs one,
# and ssh_remote sends it as the first line of stdin, ahead of the archive. The
# remote prelude reads that line and feeds it to `sudo -S` for each privileged
# command, so the password never appears in a command line.
#
# Callers set SSH_TARGET, SSH_PORT_ARGS (array) and REMOTE_SUDO before use.

# Quote a value for the remote shell.
quote_remote() {
  local value="${1}"
  printf "'%s'" "${value//\'/\'\\\'\'}"
}

SUDO_PASSWORD_NEEDED=0

# Probe the remote sudo; when it needs a password, read it from
# DEPLOY_SUDO_PASSWORD or prompt on the terminal (once per run).
remote_sudo_init() {
  SUDO_PASSWORD_NEEDED=0
  if [[ "${REMOTE_SUDO}" != "1" ]]; then
    return
  fi
  if ssh "${SSH_PORT_ARGS[@]}" "${SSH_TARGET}" 'sudo -n true' </dev/null 2>/dev/null; then
    return
  fi
  SUDO_PASSWORD_NEEDED=1
  if [[ -n "${DEPLOY_SUDO_PASSWORD:-}" ]]; then
    return
  fi
  if ! { true </dev/tty; } 2>/dev/null; then
    echo "sudo on ${SSH_TARGET} needs a password: set DEPLOY_SUDO_PASSWORD or run from a terminal" >&2
    exit 1
  fi
  IFS= read -rs -p "[sudo] password for ${SSH_TARGET}: " DEPLOY_SUDO_PASSWORD </dev/tty
  echo >&2
}

# Print the remote prelude that defines `run`, which runs a command with sudo
# when REMOTE_SUDO=1 and directly otherwise.
remote_prelude() {
  printf '%s\n' 'set -euo pipefail'
  if [[ "${REMOTE_SUDO}" != "1" ]]; then
    printf '%s\n' 'run() { "$@"; }'
  elif [[ "${SUDO_PASSWORD_NEEDED}" == "1" ]]; then
    printf '%s\n' \
      'IFS= read -r SUDO_PASSWORD' \
      'run() { printf "%s\n" "${SUDO_PASSWORD}" | sudo -S -p "" "$@"; }' \
      'run true || { echo "sudo authentication failed" >&2; exit 1; }'
  else
    printf '%s\n' 'run() { sudo -n "$@"; }'
  fi
}

# ssh_remote <script>: run the prelude plus <script> with bash on the remote
# host. The caller's stdin follows the password line (if any) on the remote
# stdin. Commands that read stdin (tar) must run as the SSH user, not via
# `run`, so that sudo cannot consume part of it.
ssh_remote() {
  local script
  script="$(remote_prelude)"$'\n'"${1}"
  {
    if [[ "${SUDO_PASSWORD_NEEDED}" == "1" ]]; then
      printf '%s\n' "${DEPLOY_SUDO_PASSWORD}"
    fi
    cat
  } | ssh "${SSH_PORT_ARGS[@]}" "${SSH_TARGET}" "bash -c $(quote_remote "${script}")"
}

# remote_install_script <dest dir>: a remote script that extracts the tar archive
# on stdin into a staging directory as the SSH user, then copies it into
# <dest dir> with `run`. `cp -f` unlinks a destination it cannot open and
# creates it anew, so it replaces the backend binary while Grafana runs it
# (a plain cp fails with "Text file busy").
remote_install_script() {
  local dest_q
  dest_q="$(quote_remote "${1}")"
  printf '%s\n' \
    'STAGING_DIR="$(mktemp -d)"' \
    'trap '\''rm -rf "${STAGING_DIR}"'\'' EXIT' \
    'tar -C "${STAGING_DIR}" -xf -' \
    "run mkdir -p ${dest_q}" \
    "run cp -Rf \"\${STAGING_DIR}/.\" ${dest_q}"
}
