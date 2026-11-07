# AGENTS.md

## Rules
- Never edit `.config/` (Grafana's plugin tools manage it) or the vendored `.agents/skills/agent-browser/` (pinned by `skills-lock.json`).
- For Grafana plugin APIs follow https://grafana.com/developers/plugin-tools/, not training data, which is out of date.
- Run Go commands on `./pkg/...`, never `./...`: `npm ci` installs a Go package (flatted) under `node_modules/`.
- Keep both settings shapes tested: multi-cluster and the legacy single-cluster shape that `applyLegacyDefaults()` migrates.

## Compatibility contracts
- Plugin ID, type and backend executable (`src/plugin.json`): never change.
- Template IDs (`pkg/plugin/templates/templates.go`); exported dashboard JSON (`pkg/plugin/export.go`).
- Resource routes and their JSON, including the `jobs` cursor (`pkg/plugin/app.go`, `service.go`, `resources.go`; consumed by `src/api/`).
- Settings `jsonData`/`secureJsonData` keys and the migrated legacy keys (`pkg/plugin/settings/settings.go`, `src/components/AppConfig/`).
- MetricSifter sidecar API: `dev/metricsifter_service/app.py` ↔ `autoFilterRequest`/`autoFilterResponse` in `pkg/plugin/resources.go`.
- The slurmdbd schema as read by `pkg/plugin/slurm/repository.go`, `types.go`; node list notation and its 10000-node budget (`nodeutil.go`).

## Before opening a pull request
- `npm ci`, then `make check`; also `make test-integration` (or the `verify-grafana-ui` skill) for frontend pages or routes.
- Parsers (node lists, TRES, settings, query parameters): also `make test-fuzz`; dependencies: also `make vuln vuln-deps`.
- `ExpandNodeList`, `parseTRESGPUs`, `ComputeNodeHealth` (up to 20000 rows per request): also `make bench` before and after.
- `src/plugin.json`: restart Grafana (it reads the file only at start) and say so in the PR.

## Git conventions
- Branches: `<type>/<issue>-<summary>` (`<type>/<summary>` without an issue); tools' `agent/*`, `claude/*`, `copilot/*`, `dependabot/*` keep their names.
- Commits and PR titles: Conventional Commits 1.0.0, types `feat` `fix` `perf` `refactor` `test` `docs` `build` `ci` `chore` `revert`; scopes: `slurm`, `settings`, `templates`, `node-health`, `job-search`, `job-dashboard`, `metric-compare`, `sidecar`.
