# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Grafana app plugin for monitoring Slurm jobs on GPU clusters. Go backend queries slurmdbd's MariaDB/MySQL for job metadata; React frontend uses Grafana Scenes API to build per-job dashboards with PromQL queries against Prometheus/VictoriaMetrics (DCGM exporter for GPU, node_exporter for CPU/mem/net/disk).

## Build & Development Commands

```bash
# Install dependencies
npm install

# Start local environment (Grafana + Prometheus + MariaDB with mock data)
docker compose up -d

# Frontend (watch mode)
npm run dev

# Backend (uses grafana-plugin-sdk-go's mage build)
mage -v build:linux   # or build:darwin for macOS

# Go tests
go test ./pkg/... -v

# Single Go test
go test ./pkg/plugin/... -run TestFunctionName -v

# Frontend tests (Jest)
npm test

# Single frontend test
npx jest --testPathPattern=model.test

# Type check
npm run typecheck

# Lint
npm run lint

# E2E tests (Playwright)
npm run e2e:setup && npm run e2e
```

Open http://localhost:3000 (admin/admin) after `docker compose up`.

## Architecture

### Backend (Go) — `pkg/`

- `pkg/main.go` — Plugin entry point, registers the app with grafana-plugin-sdk-go
- `pkg/plugin/app.go` — `App` struct implementing `CallResourceHandler` + `CheckHealth`. HTTP routes registered via `net/http.ServeMux`:
  - `GET /api/clusters`, `GET /api/jobs`, `GET /api/jobs/{clusterId}/{jobId}`
  - `GET /api/templates`, `POST /api/dashboards/export`
- `pkg/plugin/service.go` — `CatalogService`: business logic layer. Resolves clusters, enforces access rules, maps slurm.Job → JobRecord
- `pkg/plugin/repositories.go` — `RepositoryManager`: lazy-creates and caches `slurm.Repository` per cluster
- `pkg/plugin/resources.go` — HTTP handler implementations, cursor-based pagination
- `pkg/plugin/export.go` — Dashboard export: builds Grafana dashboard JSON payload and POSTs to Grafana API
- `pkg/plugin/settings/` — Multi-cluster config model (`Settings`, `ClusterProfile`, `ConnectionProfile`). Supports legacy single-cluster format via `applyLegacyDefaults()`
- `pkg/plugin/slurm/` — Data access layer. `Repository` queries `{cluster}_job_table` / `{cluster}_assoc_table` in slurmdbd's MySQL schema. `ExpandNodeList` parses Slurm compressed node notation (e.g., `node[001-003]`)
- `pkg/plugin/templates/` — Dashboard template selection logic. Auto-selects template based on job name patterns and GPU count (inference vs distributed-training vs overview)
- `pkg/plugin/access.go` — Access rule type alias

Key pattern: `App` → `CatalogService` → `JobRepository` (interface) → `slurm.Repository` (MySQL impl). `RepositoryManager` lazily creates repositories using `ConnectionProfile.DSN()`.

### Frontend (TypeScript/React) — `src/`

- `src/module.tsx` — Plugin module entry point
- `src/api/slurmApi.ts` + `src/api/types.ts` — API client for backend endpoints
- `src/pages/JobSearch/` — Job search page with filters (cluster, user, partition, state, name)
- `src/pages/JobDashboard/` — Per-job dashboard page
  - `scenes/jobDashboardScene.ts` — Builds `EmbeddedScene` with template-aware layout (collapsed/expanded sections)
  - `scenes/model.ts` — Time range calculation, instance matcher construction for PromQL
  - `scenes/gpuPanels.ts`, `cpuMemoryPanels.ts`, `networkPanels.ts`, `diskPanels.ts` — Panel builders
- `src/storage/userPreferences.ts` — localStorage persistence for search filters and recent jobs
- `src/components/AppConfig/AppConfig.tsx` — Plugin configuration UI

### Test files

- Go: `*_test.go` files alongside source. Uses `export_test.go` to expose internals for white-box tests
- Frontend: `*.test.ts` files in `src/`. Jest with `@swc/jest` transform
- E2E: `e2e/tests/` with Playwright. Page objects in `e2e/pages/`

### Local dev stack (`docker-compose.yaml`)

- Grafana 12.4.0 (mounts `dist/` as plugin, unsigned allowed)
- Prometheus (config in `dev/prometheus.yml`)
- MariaDB 11 (seed data in `dev/initdb/`)

## Conventions

- Go: standard `gofmt`. Parameterized SQL queries with `?` placeholders (never string interpolation for user values). Table names use validated cluster name prefix
- TypeScript: 2-space indent, ESLint. React components in PascalCase
- Commit prefixes: `fix:`, `feat:`, `ci:`, `chore:`
- Plugin ID: `yuuki-slurm-app`
- Multi-cluster support: settings model allows multiple connections and clusters; single-cluster config auto-migrated via `applyLegacyDefaults()`
