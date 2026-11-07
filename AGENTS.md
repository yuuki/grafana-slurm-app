# AGENTS.md

Rules for coding agents (and humans) that the code does not show: what the
code, `make help`, README.md and docs/ already say is not repeated here.

## Rules the code does not show

- English only. Use Grafana's official plugin docs
  (https://grafana.com/developers/plugin-tools/): training data is outdated.
- Run Go commands on `./pkg/...`, never `./...`: `npm ci` installs a Go
  package (flatted) under `node_modules/`.
- SQL: values only as `?` placeholders. Table names come from the cluster
  name validated against `^[a-zA-Z0-9_-]+$`, backtick-quoted; each
  `fmt.Sprintf` query carries `//nolint:gosec // G201: <reason>`.
- Responses never carry internal error detail (unexpected errors: log, then
  a generic 500). Never log passwords or DSNs.
- `App.Dispose()` closes every repository (Grafana makes a new `App` per
  settings version). A backend goroutine needs an owner stopping it there.
- Keep bounded: request bodies, the MetricSifter call and its response, node
  list expansion (10000 nodes; malformed input is an error, never a panic).
- Filter in SQL; only the node-name filter runs in Go, so `ExpandNodeList`,
  `parseTRESGPUs` and `ComputeNodeHealth` see up to 20000 rows per request:
  keep them allocation-light. Scope PromQL to the job's nodes and time range.
- Keep both settings shapes tested: multi-cluster and legacy single-cluster.

## Compatibility contracts

- Plugin ID, type and backend executable (`src/plugin.json`): never change.
- Resource routes and their JSON, including the `jobs` cursor
  (`pkg/plugin/app.go`, `service.go`, `resources.go`; consumed by `src/api/`).
- Settings `jsonData`/`secureJsonData` keys and the legacy keys still
  migrated (`pkg/plugin/settings/settings.go`, `src/components/AppConfig/`).
- Template IDs (`pkg/plugin/templates/templates.go`); exported dashboard JSON
  (`pkg/plugin/export.go`).
- MetricSifter sidecar API: `dev/metricsifter_service/app.py` and
  `autoFilterRequest`/`autoFilterResponse` in `pkg/plugin/resources.go`
  change together.
- The slurmdbd schema as read by `pkg/plugin/slurm/repository.go` and
  `types.go` (slurmdbd owns it); node list notation and its 10000-node
  budget (`pkg/plugin/slurm/nodeutil.go`).

## Before opening a pull request

`npm ci`, then `make check`. Also, when you touch:

- frontend pages or routes: `make test-integration`, or the
  `verify-grafana-ui` skill against the Docker Compose stack;
- parsers (node lists, TRES, settings, query parameters): `make test-fuzz`;
  commit any crasher under `testdata/fuzz/` with the fix;
- `ExpandNodeList`, `parseTRESGPUs`, `ComputeNodeHealth`: `make bench`
  before and after (benchstat);
- dependencies: `make vuln vuln-deps`;
- `src/plugin.json`: restart Grafana (it reads the file only at start) and
  say so in the PR.

## Git conventions

Branches: `<type>/<issue>-<summary>`, or `<type>/<summary>` without an issue
(`fix/166-connect-errors`, `feat/qp-counters`). `<type>` is a commit type
below; `<summary>` is 2–5 lowercase ASCII words joined by `-`. Branches named
by tools keep their names (`agent/*`, `claude/*`, `copilot/*`,
`dependabot/*`). Never push to the default branch.

Commits follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):

    <type>(<scope>)!: <subject>

    <body>

    <footer>

- `type`: `feat` (new user-visible behaviour), `fix` (bug fix), `perf`,
  `refactor` (no behaviour change), `test`, `docs`, `build` (build system,
  dependencies, packaging), `ci` (workflows), `chore` (anything else, e.g.
  `chore(release): prepare v1.2.3`), `revert`.
- `scope`: optional; the package or area changed: `slurm`, `settings`,
  `templates`, `node-health`, `job-search`, `job-dashboard`,
  `metric-compare`, `sidecar`.
- `!` and a `BREAKING CHANGE: <what changed and how to migrate>` footer for
  any change to a compatibility contract above.
- `subject`: imperative, lower case (except identifiers), no final period,
  at most 72 characters including the prefix.
- `body`: why the change is needed and what it affects, wrapped at 72
  columns; required unless the subject says everything.
- `footer`: `Fixes #N` / `Refs #N`, `BREAKING CHANGE:`, trailers such as
  `Co-Authored-By:`.
- One logical change per commit; regenerated files go in the commit that
  changes their source. Pull request titles use the same format (they become
  the squash commit).

## Forbidden

- Disabling, skipping, deleting or weakening tests, lint rules or CI checks
  to get green (`|| true`, `continue-on-error`, blanket excludes).
- Editing by hand `.config/` (Grafana's plugin tools manage it), generated
  files, or the vendored `.agents/skills/agent-browser/` (pinned by
  `skills-lock.json`).
- Changing a compatibility contract without calling it out.
- Adding dependencies without a justification in the PR.
- Loosening workflow permissions, unpinning actions, adding caches to the
  release workflow.
- Committing secrets (the Compose stack's `admin/admin` and `slurm/slurm`
  are dev defaults only); rewriting history, force-pushing, tagging or
  publishing releases.

## Needs human review

Even with green CI: `.github/` (workflows, `release.yml`, `dependabot.yml`),
permissions and secrets, `secureJsonData` handling and access rules
(`AccessRule`), SQL construction, parsers of external input (node lists,
TRES strings, settings, query parameters, MetricSifter responses), the
compatibility contracts, dependency additions and large refactors.
