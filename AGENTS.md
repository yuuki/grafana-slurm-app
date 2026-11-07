# AGENTS.md

Guide for coding agents (and humans) working in this repository. User-facing
documentation is in [README.md](README.md) and [docs/](docs/overview.md);
contribution basics are in [CONTRIBUTING.md](CONTRIBUTING.md).

## 1. Overview and architecture

Grafana app plugin (`yuuki-slurm-app`, type `app`, backend executable
`gpx_slurm_app`) for monitoring Slurm jobs on GPU clusters. Three parts:

- **Go backend** (`pkg/`): serves the plugin's resource API over Grafana's
  `CallResource` and reads job data from slurmdbd's MariaDB/MySQL database.
- **React frontend** (`src/`): Grafana Scenes pages (job search, job
  dashboard, metric explorer/compare, node health, app config). It queries
  Prometheus/VictoriaMetrics directly through the configured Grafana
  datasource with PromQL (DCGM exporter for GPUs, node_exporter for
  CPU/memory/network/disk), and calls Grafana's own APIs for dashboard export,
  folders, users and annotations.
- **MetricSifter sidecar** (`dev/metricsifter_service/`, Python/FastAPI):
  optional change-point based metric auto-filter. Deployed next to Grafana
  (`scripts/deploy-full-ssh.sh`) and part of the Docker Compose stack.

Data flow:

```
Grafana UI ──/api/plugins/yuuki-slurm-app/resources/api/*──▶ App (pkg/plugin/app.go)
                                                             └▶ CatalogService ─▶ JobRepository ─▶ slurm.Repository ─▶ slurmdbd MySQL
           ──POST /api/metrics/auto-filter──▶ App ──POST /v1/filter──▶ MetricSifter sidecar
           ──PromQL (Grafana datasource)──▶ Prometheus / VictoriaMetrics
```

- Layering: `App` → `CatalogService` (access rules, record mapping,
  template selection) → `JobRepository` (interface) → `slurm.Repository`
  (MySQL). `RepositoryManager` lazily creates one repository per cluster from
  `ConnectionProfile.DSN()` and closes them all on `App.Dispose()`.
- Routes (`pkg/plugin/app.go`): `GET /api/clusters`, `GET /api/nodes/health`,
  `GET /api/jobs`, `GET /api/jobs/metadata/options`,
  `GET /api/jobs/{clusterId}/{jobId}`, `GET /api/templates`,
  `POST /api/dashboards/export`, `POST /api/metrics/auto-filter`.
- Settings (`pkg/plugin/settings/`): multi-connection, multi-cluster model.
  The legacy single-cluster shape (`dbHost`, `clusterName`, ...) is migrated
  by `applyLegacyDefaults()` into one `default` connection and one cluster.
- Templates (`pkg/plugin/templates/`): built-in dashboard templates chosen by
  job name pattern, partition and GPU count, unless overridden.
- `slurm.ExpandNodeList` expands compressed node notation (`node[001-003]`,
  `rack[1-2]-node[01-02]`) with a 10000-node budget; malformed lists return an
  error and callers fall back to the raw string as one node name.
- Frontend entry: `src/module.tsx` → pages in `src/pages/`; API client in
  `src/api/`.

## 2. Directory layout

| Path | Contents |
|------|----------|
| `pkg/main.go` | Plugin entry point (`app.Manage`) |
| `pkg/plugin/` | App, HTTP handlers (`resources.go`), catalog service, node health, dashboard export |
| `pkg/plugin/settings/` | Settings model, defaults, legacy migration, validation |
| `pkg/plugin/slurm/` | slurmdbd repository (SQL), node list expansion, TRES parsing |
| `pkg/plugin/templates/` | Built-in dashboard templates and selection |
| `src/` | Frontend (`plugin.json`, pages, components, API client, tests `*.test.ts(x)`) |
| `e2e/` | Playwright E2E tests, page objects, extra seed SQL, `run.sh` |
| `dev/` | Docker Compose dev data (`initdb/`), mock exporter, metrics generators, MetricSifter sidecar |
| `provisioning/` | Grafana provisioning for the dev/E2E stack |
| `scripts/` | Install and SSH deploy scripts |
| `docs/` | User guide; `docs/plans/` and `docs/superpowers/` hold design notes and plans |
| `.config/` | Managed by Grafana plugin tools (webpack config). **Do not edit.** |
| `.agents/skills/` | Agent skills: `verify-grafana-ui` (maintained here) and `agent-browser` (vendored, pinned in `skills-lock.json`) |
| `.claude/skills/` | Relative symlinks to `.agents/skills/*` so Claude Code finds the skills |

## 3. Build

Requirements: Node.js 26 (`engines` in `package.json`, `mise.toml`), Go from
`go.mod` (1.27.3), Docker for the dev stack, `uv` for the sidecar tests.

```bash
npm ci                    # frontend dependencies
make build                # npm run build (webpack) + mage -v build:linux, into dist/
npm run build             # frontend only
mage -v build:linux       # backend only (or: go run github.com/magefile/mage@v1.17.2 -v build:linux)
mage -l                   # all SDK build targets (build:darwin, build:linuxARM64, buildAll, ...)
```

Local environment (Grafana + Prometheus + MariaDB with mock data + mock
exporter + MetricSifter):

```bash
./dev/setup.sh            # generate metrics, backfill Prometheus, start everything
docker compose up -d      # or just start the stack
docker compose port grafana 3000   # Grafana's port is random unless GRAFANA_PORT is set
npm run dev               # frontend watch mode
```

Grafana runs at the reported address (admin/admin) with `dist/` mounted as
the plugin. A changed `src/plugin.json` needs a Grafana restart.

## 4. Test

| Command | What | Needs |
|---------|------|-------|
| `make test-go` | Go unit tests (`go test ./pkg/...`) | — |
| `make test-race` | Go unit tests with `-race` | — |
| `go test ./pkg/plugin/... -run TestName -v` | One Go test | — |
| `make test-frontend` | Jest (`npm run test:ci`) | `npm ci` |
| `npx jest --testPathPattern=model.test` | One frontend test file | `npm ci` |
| `make test-sidecar` | MetricSifter pytest, on the Python version of its Dockerfile | `uv`, network on first run |
| `make test` | All three unit suites | as above |
| `make test-fuzz` | Every Go fuzz target for `FUZZTIME` (default 30s) | — |
| `make bench` | Go benchmarks into `bench.txt` (compare with benchstat) | — |
| `make test-integration` | Playwright E2E (`e2e/run.sh`: builds, starts the Compose stack, runs chromium, tears down) | Docker; `npx playwright install chromium` once |

- Always run `npm run typecheck` after frontend changes and the Go tests after
  backend changes. `tsc` excludes `*.test.ts(x)`; Jest type-strips them.
- Go tests are white-box tests in the package under test. Repositories are
  tested with go-sqlmock; HTTP handlers with `httptest` and a stub
  `JobRepository`.
- `pkg/plugin` and `pkg/plugin/slurm` run under `goleak.VerifyTestMain`: close
  every `*sql.DB`, `httptest.Server` and response body a test opens.
- Fuzz targets: `FuzzExpandNodeList`, `FuzzParseTRESGPUs` (slurm),
  `FuzzParse` (settings), `FuzzParseListOptions` (plugin). A failing input
  lands in `testdata/fuzz/<Target>/`; commit it with the fix as a regression
  seed. On a shared machine use `make test-fuzz FUZZTIME=15s FUZZFLAGS=-parallel=2`.
- Multi-cluster and legacy single-cluster settings must both stay tested.
- UI checks in a real browser: the `verify-grafana-ui` skill (uses
  `agent-browser`) against the Compose stack.

## 5. Static analysis

```bash
make lint          # golangci-lint on ./pkg/... (.golangci.yml), go mod tidy -diff, tsc, ESLint
make fmt           # golangci-lint fmt (gofmt); frontend: npm run lint:fix
make lint-actions  # actionlint + zizmor on .github/ (offline unless GH_TOKEN is set)
make vuln          # govulncheck on ./pkg/...
make vuln-deps     # osv-scanner on package-lock.json and the sidecar requirements.txt
                   # (CI: make vuln-deps-sarif uploads the findings to code scanning)
make complexity    # cccc ranking; limits in cccc.toml (CI: complexity.yml + octocov)
```

Go commands use `./pkg/...`, never `./...`: `npm ci` installs a Go package
(flatted) under `node_modules/`. Tool versions are pinned at the top of the
`Makefile` and match `.github/workflows/`.

## 6. Coding conventions

- **SQL**: parameterized queries with `?` placeholders only, never string
  interpolation of request or settings values. Table names come from the
  cluster name validated against `^[a-zA-Z0-9_-]+$` and are backtick-quoted;
  each `fmt.Sprintf` query carries a `//nolint:gosec // G201` reason.
- **Errors**: wrap with `%w`. Handlers map `ErrForbidden`/`ErrClusterNotFound`
  to 403/404; anything else is logged and returned as a generic 500 without
  internal detail. Invalid query parameters are clamped or rejected with 400.
- **Logging**: `github.com/grafana/grafana-plugin-sdk-go/backend/log`
  (`log.DefaultLogger`, key/value pairs). Never log passwords or DSNs.
- **Go**: gofmt; comments explain why. **TypeScript**: 2-space indent, ESLint
  (`@grafana/eslint-config`), React components in PascalCase, tests next to
  the code as `*.test.ts(x)` (Jest with `@swc/jest`).
- Use Grafana's official documentation for plugin APIs
  (https://grafana.com/developers/plugin-tools/); training data is outdated.
- English for code, comments, docs and commit messages.
- **Commits**: `feat:`, `fix:`, `refactor:`, `docs:`, `ci:`, `chore:`.

## 7. Compatibility contracts

Do not change these silently; call them out in the PR.

| Contract | Defined in |
|----------|-----------|
| Plugin ID `yuuki-slurm-app`, type `app`, executable `gpx_slurm_app` (never change) | `src/plugin.json` |
| Resource routes and their JSON (`ClusterSummary`, `JobRecord`, `NodeHealthPayload`, list `{jobs,nextCursor,total}`) | `pkg/plugin/app.go`, `service.go`, `resources.go`; consumed by `src/api/` |
| `jobs` cursor = base64 of the decimal offset | `pkg/plugin/resources.go` |
| Settings `jsonData` keys, `secureJsonData` keys (`dbPassword`, per-connection `securePasswordRef`), legacy keys still migrated | `pkg/plugin/settings/settings.go`, `src/components/AppConfig/` |
| Template IDs `overview`, `distributed-training`, `inference` | `pkg/plugin/templates/templates.go` |
| Exported dashboard JSON | `pkg/plugin/export.go` |
| MetricSifter API: `POST /v1/filter` request/response, `GET /healthz` | `dev/metricsifter_service/app.py` ↔ `autoFilterRequest`/`autoFilterResponse` in `resources.go` |
| slurmdbd schema: `<cluster>_job_table`, `<cluster>_assoc_table`, `tres_table`, optional `failed_node`, state integers | `pkg/plugin/slurm/repository.go`, `types.go` |
| Node list notation and the 10000-node budget | `pkg/plugin/slurm/nodeutil.go` |

## 8. Concurrency and resource management

- Grafana creates one `App` per settings version and calls `Dispose()` when
  settings change; `Dispose()` must close every repository (`*sql.DB` pool,
  5 open / 2 idle / 5 min lifetime).
- `RepositoryManager` guards its map with a mutex; `slurm.Repository` caches
  GPU TRES IDs and the `failed_node` column check behind their own mutexes.
- Pass the request context to every DB query and to the MetricSifter call.
  The MetricSifter client has a 10 s timeout; request bodies are capped with
  `http.MaxBytesReader` (1 MiB export, 20 MiB auto-filter) and the sidecar
  response with a 5 MiB `io.LimitReader`.
- The backend starts no goroutines of its own; keep it that way or give each
  one an owner that stops it in `Dispose()`.

## 9. Performance constraints

- A node-name filter fetches up to 10000 candidate rows and expands every
  nodelist in Go; node health scores up to 20000 jobs per request. Keep
  `ExpandNodeList`, `parseTRESGPUs` and `ComputeNodeHealth` allocation-light
  (see `make bench`) and keep other filtering in SQL.
- Node list expansion is bounded (10000 nodes, no unbounded work on malformed
  input); do not weaken those limits.
- Frontend PromQL is built per panel; keep queries scoped to the job's nodes
  and time range.

## 10. Before opening a PR

Run `make check` (lint, lint-actions, race tests, Jest, sidecar tests). Also:

- Frontend pages or routes changed: `make test-integration`, or the
  `verify-grafana-ui` skill against the Compose stack.
- `src/plugin.json` changed: restart Grafana; note it in the PR.
- Workflows changed: `make lint-actions` (already in `make check`).
- Dependencies changed: `make vuln vuln-deps`.
- Parsers changed (node lists, TRES, settings, query parameters): `make test-fuzz`.

## 11. Rules for AI agents

Never:

- disable, skip, delete or weaken tests, lint rules or CI checks to get green
  (no `|| true`, `continue-on-error`, blanket excludes);
- edit `.config/` (Grafana plugin tools), generated files or vendored skills
  (`.agents/skills/agent-browser/`, pinned by `skills-lock.json`) by hand;
- change the plugin ID or type, or any contract in section 7 without calling
  it out;
- add dependencies without a justification in the PR;
- loosen workflow permissions, unpin actions or add caches to the release
  workflow;
- commit secrets (the Compose stack's `admin/admin` and `slurm/slurm` are dev
  defaults only);
- rewrite history, force-push, tag or publish releases.

## 12. Changes that need human review

Even with green CI: `.github/` workflows and `release.yml`, permissions and
secrets, `secureJsonData` handling and access rules (`AccessRule`), SQL
construction, parsers of external input (node lists, TRES strings, settings,
query parameters, MetricSifter responses), the sidecar API, public contracts
(section 7), dependency additions, and large refactors.
