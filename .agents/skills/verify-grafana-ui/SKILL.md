---
name: verify-grafana-ui
description: >
  Automate Grafana app plugin UI verification using agent-browser.
  Opens the local Grafana instance in a headless browser to check element presence/absence,
  page transitions, and visual correctness after frontend changes.
  Use this skill for requests like "verify the UI", "check in the browser", "run a visual test",
  or any pre-commit/pre-PR confirmation of UI behavior.
  Works in combination with the agent-browser skill.
allowed-tools: Bash(agent-browser:*), Bash(npx agent-browser:*)
---

# Grafana UI Verification with agent-browser

Verify Grafana app plugin UI by accessing the local dev environment with agent-browser.
Check page content, element presence/absence, and page navigation in a real browser.

For basic agent-browser operations (snapshot, click, fill, etc.), refer to the `agent-browser` skill.
This skill provides Grafana plugin development-specific procedures and troubleshooting.

## Workflow

```
1. Build      Build frontend + Go backend
2. Docker     Resolve port conflicts, docker compose up
3. Health     curl /api/health until 200
4. Login      Login as admin/admin via agent-browser
5. Verify     snapshot / screenshot / text search on target pages
6. Report     Summarize findings with screenshots
7. Cleanup    Close browser, restore stopped containers
```

## 1. Build

Both frontend and backend must be built so the Docker-mounted `dist/` directory has the latest artifacts.

```bash
npm run build
GOOS=linux GOARCH=amd64 go build -o dist/gpx_slurm_app_linux_amd64 ./pkg
```

If the Go binary is missing from `dist/`, Grafana will crash on startup.
The log will show `Could not start plugin backend ... no such file or directory`.

## 2. Docker Compose

```bash
docker ps                               # check for port conflicts
GRAFANA_PORT=3000 docker compose up -d
```

Ports 3000, 9090, 3306, and 9999 often conflict with containers from the main repo or other worktrees.
Stop conflicting containers first:

```bash
cd /path/to/main-repo && docker compose stop
```

Always restore stopped containers after verification (see step 7).

## 3. Health Check

```bash
sleep 5 && curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/api/health
```

If not 200, inspect logs with `command docker logs --tail 30 <container>`.
The `command` prefix bypasses the `rtk` wrapper that may reject certain flags.

## 4. Grafana Login

All agent-browser commands require **`dangerouslyDisableSandbox: true`** because the
`~/.agent-browser` socket directory needs write access outside the sandbox.

```bash
agent-browser close 2>/dev/null          # clean up any previous session
agent-browser open http://localhost:3000 && agent-browser wait --load networkidle
agent-browser snapshot -i                # discover login form refs
```

On the login page:
- `@e1` = Email or username field -> fill with `"admin"`
- `@e2` = Password field -> fill with `"admin"`
- `@e4` = Log in button

If a password-change screen appears, click the "Skip" button.

## 5. Verification

### Plugin Page URLs

Plugin pages follow the `/a/<plugin-id>/<page>` pattern:
- Job list: `/a/yuuki-slurm-app/jobs`
- Job dashboard: `/a/yuuki-slurm-app/job/<clusterId>/<jobId>`

```bash
agent-browser open http://localhost:3000/a/yuuki-slurm-app/jobs
agent-browser wait --load networkidle
agent-browser snapshot -i
```

### Verification Patterns

**Confirm an element does NOT exist** (e.g., after removing a feature):

```bash
agent-browser get text body 2>&1 | grep -i "search_term"
# No output means the element is absent
```

Also verify the target button/link is absent from `snapshot -i` output.

**Click table rows**:

Grafana table rows use `<tr onclick>` and do not appear in a standard `snapshot -i`.
Use the `-C` flag to include cursor-interactive elements:

```bash
agent-browser snapshot -i -C
# clickable "10007debug_mnist_gpu..." [ref=e34] [cursor:pointer, onclick]
```

**Visual confirmation with screenshots**:

```bash
agent-browser screenshot --annotate   # numbered element labels
agent-browser screenshot --full       # full-page capture
```

Use the `Read` tool on the saved screenshot to present it to the user.
Screenshots are saved under `~/.agent-browser/tmp/screenshots/`.

**Compare before/after with diff**:

```bash
agent-browser snapshot -i             # baseline
# ... perform some action ...
agent-browser diff snapshot           # show what changed
```

## 6. Report

Summarize verification results in this format:

```
## Verification Results

1. **<check item>** - OK / NG
   - What was checked
   - [screenshot]
```

For each item, state what was verified, the result, and include a screenshot if available.

## 7. Cleanup

```bash
agent-browser close
docker compose down
# restore any containers stopped in step 2
cd /path/to/main-repo && docker compose start
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Socket directory is not writable` | Sandbox restriction | Set `dangerouslyDisableSandbox: true` |
| `Daemon failed to start` | Stale session | `agent-browser close` then retry |
| `Could not start plugin backend` | Go binary not built | `GOOS=linux GOARCH=amd64 go build -o dist/gpx_slurm_app_linux_amd64 ./pkg` |
| `Bind for 127.0.0.1:XXXX failed` | Port conflict | `docker ps` to identify, stop conflicting container or change `GRAFANA_PORT` |
| `docker logs --tail` errors | `rtk` wrapper | Use `command docker logs --tail 30` |
| Jest finds no tests | Worktree path contains `.git` | Use `tsc --noEmit` for type checking, or run tests from the main repo |
