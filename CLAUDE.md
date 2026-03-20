# CLAUDE.md

Grafana app plugin for monitoring Slurm jobs on GPU clusters. Go backend queries slurmdbd's MariaDB/MySQL; React frontend uses Grafana Scenes API for per-job dashboards with PromQL (DCGM exporter for GPU, node_exporter for CPU/mem/net/disk).

## Build & Dev Commands

```bash
npm install                        # Install frontend deps
docker compose up -d               # Start local env (Grafana + Prometheus + MariaDB with mock data)
npm run dev                        # Frontend watch mode
mage -v build:linux                # Backend build (or build:darwin for macOS)
```

Open http://localhost:3000 (admin/admin) after `docker compose up`.

## Testing & Verification

```bash
go test ./pkg/... -v                          # All Go tests
go test ./pkg/plugin/... -run TestName -v     # Single Go test
npm test                                      # Frontend tests (Jest)
npx jest --testPathPattern=model.test         # Single frontend test
npm run typecheck                             # Type check
npm run lint                                  # Lint
npm run e2e:setup && npm run e2e              # E2E tests (Playwright)
```

IMPORTANT: Always run `npm run typecheck` after frontend changes and `go test ./pkg/... -v` after backend changes to verify your work.

## Architecture

Key layering pattern: `App` → `CatalogService` → `JobRepository` (interface) → `slurm.Repository` (MySQL impl). `RepositoryManager` lazily creates repositories using `ConnectionProfile.DSN()`.

- Backend entry: `pkg/plugin/app.go` — HTTP routes via `net/http.ServeMux`
  - `GET /api/clusters`, `GET /api/jobs`, `GET /api/jobs/{clusterId}/{jobId}`
  - `GET /api/templates`, `POST /api/dashboards/export`
- Frontend entry: `src/module.tsx` → pages under `src/pages/`
- Settings model in `pkg/plugin/settings/` supports multi-cluster config with legacy single-cluster auto-migration via `applyLegacyDefaults()`
- Dashboard templates in `pkg/plugin/templates/` auto-select based on job name patterns and GPU count

See @README.md for project overview.

## Conventions

- **SQL**: parameterized queries with `?` placeholders only — never string interpolation for user values. Table names use validated cluster name prefix
- **TypeScript**: 2-space indent, ESLint. React components in PascalCase
- **Commits**: `fix:`, `feat:`, `ci:`, `chore:` prefixes
- **Plugin ID**: `yuuki-slurm-app`
- **Go tests**: `export_test.go` exposes internals for white-box tests
- **Frontend tests**: `*.test.ts` files in `src/`, Jest with `@swc/jest` transform

## Gotchas

- Multi-cluster support: settings model allows multiple connections and clusters; single-cluster config is auto-migrated — always test both paths
- `slurm.ExpandNodeList` parses compressed node notation (e.g., `node[001-003]`) — edge cases exist around nested brackets and ranges
- E2E tests require `npm run e2e:setup` before first run to install Playwright browsers
