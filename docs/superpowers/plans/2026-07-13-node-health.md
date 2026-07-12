# Node Health (Bad Node Finder) Implementation Plan

> **For agentic workers:** This plan is executed by a single high-capability
> implementer (Codex). Work task-by-task in order, TDD within each task,
> one commit per task. Steps use checkbox (`- [ ]`) syntax for tracking.
> Spec: `docs/superpowers/specs/2026-07-13-node-health-design.md` — read it
> first; it is the source of truth for scoring formulas and the API contract.

**Goal:** Rank compute nodes by job-failure correlation on a new "Node Health" page, from slurmdbd history only (Phase 1).

**Architecture:** New `GET /api/nodes/health` route follows the existing `App → CatalogService → JobRepository → slurm.Repository` layering; nodelist expansion and scoring happen in Go as a pure function; a new React page renders the ranking and deep-links into Job Search.

**Tech Stack:** Go backend (net/http mux, sqlmock tests), React + @grafana/ui frontend (Jest), MariaDB dev seed, Playwright e2e.

## Global Constraints

- SQL: parameterized `?` placeholders only; table names built from the validated cluster prefix (`pkg/plugin/slurm/repository.go:19,76-82`).
- New handlers MUST go through `CatalogService.getCluster(clusterID, user)` — there is no mux-level auth.
- TypeScript: 2-space indent, ESLint, PascalCase components, `useStyles2(getStyles)` + emotion for styling.
- Commits: `feat:` / `test:` / `docs:` prefixes, English messages, one commit per task.
- After backend changes run `go test ./pkg/... -v`; after frontend changes run `npm run typecheck` and `npm test`.
- Scoring constants (Go code constants): `NODE_FAIL_BONUS = 2.0`, `FAILED_NODE_BONUS = 5.0`, `MIN_JOBS = 5`, job fetch cap `20000`.
- Included job states: `COMPLETED`, `FAILED`, `NODE_FAIL` only (both numerator and denominator). Failure states: `FAILED`, `NODE_FAIL`.

---

### Task 1: Scoring pure function (backend core)

**Files:**
- Create: `pkg/plugin/nodehealth.go`
- Test: `pkg/plugin/nodehealth_test.go`
- Modify: `pkg/plugin/slurm/types.go` (add `NodeStatsJob`)

**Interfaces:**
- Consumes: `slurm.ExpandNodeList(nodelist string) ([]string, error)` (existing, `pkg/plugin/slurm/nodeutil.go`).
- Produces (used by Tasks 2–3):

```go
// pkg/plugin/slurm/types.go
// NodeStatsJob is the minimal projection needed for node failure stats.
type NodeStatsJob struct {
    State      string // "COMPLETED" | "FAILED" | "NODE_FAIL" (already converted)
    NodeList   string // compressed notation
    EndTime    int64  // unix seconds
    FailedNode string // may be empty
}

// pkg/plugin/nodehealth.go
type NodeHealthStats struct {
    Name             string  `json:"name"`
    TotalJobs        int     `json:"totalJobs"`
    FailedJobs       int     `json:"failedJobs"`
    NodeFailJobs     int     `json:"nodeFailJobs"`
    FailedNodeHits   int     `json:"failedNodeHits"`
    FailureRate      float64 `json:"failureRate"`
    ExpectedFailures float64 `json:"expectedFailures"`
    Score            float64 `json:"score"`
    LastFailureAt    int64   `json:"lastFailureAt,omitempty"`
    LowSample        bool    `json:"lowSample"`
}

type NodeHealthBaseline struct {
    TotalJobs   int     `json:"totalJobs"`
    FailedJobs  int     `json:"failedJobs"`
    FailureRate float64 `json:"failureRate"`
}

// ComputeNodeHealth aggregates per-node stats and scores. Nodes are
// returned sorted by Score descending, name ascending as tiebreak.
func ComputeNodeHealth(jobs []slurm.NodeStatsJob) ([]NodeHealthStats, NodeHealthBaseline)
```

Scoring formula (copy of spec — implement exactly):
`w_j = 1/len(nodes_j)`; per node: `weightedJobs`, `weightedFailures`,
`weightedNodeFails` (NODE_FAIL only), `failedNodeHits` (exact
`FailedNode == node`, counted undivided);
`p = ΣweightedFailures / ΣweightedJobs`;
`expected(n) = weightedJobs(n) × p`;
`score(n) = (weightedFailures(n) − expected(n)) + 2.0×weightedNodeFails(n) + 5.0×failedNodeHits(n)`.
`LowSample = TotalJobs < 5`. Jobs with empty `NodeList` are skipped.
If `ExpandNodeList` errors, treat the raw string as a single node name
(same tolerance as `List` scan in `repository.go:296-301`).

- [x] **Step 1:** Write table-driven tests in `pkg/plugin/nodehealth_test.go` covering at minimum:
  - single-node failed job vs single-node completed jobs → failed node ranks first, positive score
  - fractional blame: one 4-node FAILED job contributes 0.25 weightedFailures per node
  - NODE_FAIL bonus: NODE_FAIL job outranks plain FAILED job with identical shape
  - failedNodeHits: job with `FailedNode: "gpu-node003"` adds +5.0 undivided to that node only
  - baseline robustness: uniform failures across all nodes → all scores ≈ 0 (use `math.Abs(score) < 1e-9` style tolerance)
  - `LowSample` true when TotalJobs < 5
  - empty NodeList job skipped entirely
  - invalid nodelist (e.g. `"bad[["`) treated as one literal node
  - LastFailureAt = max EndTime among failed jobs on that node; omitted (0) when no failures
  - sort order: score desc, then name asc
- [x] **Step 2:** Run `go test ./pkg/plugin/ -run TestComputeNodeHealth -v` — expect FAIL (undefined symbols).
- [x] **Step 3:** Implement `NodeStatsJob` and `ComputeNodeHealth` minimally.
- [x] **Step 4:** Run the same command — expect PASS. Then `go test ./pkg/... -v` — expect all PASS.
- [x] **Step 5:** Commit: `feat: add node health scoring from job failure history`

---

### Task 2: Repository query + failed_node exposure

**Files:**
- Modify: `pkg/plugin/slurm/repository.go` (new method; extend `jobSelectColumns` with `failed_node`)
- Modify: `pkg/plugin/slurm/types.go` (`Job.FailedNode string`), `pkg/plugin/service.go` (`JobRecord.FailedNode string \`json:"failedNode,omitempty"\``)
- Test: `pkg/plugin/slurm/repository_sqlmock_test.go` (extend), plus fix any existing tests that assert the old column list

**Interfaces:**
- Produces (used by Task 3):

```go
// ListNodeStatsJobs returns jobs with time_end in [from, to] whose state is
// COMPLETED, FAILED, or NODE_FAIL, most recent first, capped at limit.
// The bool result reports truncation (more rows existed than limit).
func (r *Repository) ListNodeStatsJobs(ctx context.Context, from, to, limit int64) ([]NodeStatsJob, bool, error)
```

Implementation notes:
- Query shape: `SELECT j.state, j.nodelist, j.time_end, COALESCE(j.failed_node, '') FROM <cluster>_job_table j WHERE j.time_end >= ? AND j.time_end <= ? AND j.time_end > 0 AND j.state IN (?, ?, ?) ORDER BY j.time_end DESC LIMIT ?` — use the existing numeric state codes from the state map in `types.go:60-71` (COMPLETED/FAILED/NODE_FAIL); pass `limit+1` and slice to detect truncation.
- State numeric→string conversion uses the existing `JobState` map directly (`pkg/plugin/slurm/types.go:60-81`, as `repository.go:296` does) — there is no dedicated helper function.
- `failed_node` is nullable `tinytext` — COALESCE or `sql.NullString`.

- [x] **Step 1:** Write sqlmock tests: happy path (3 rows, mixed states, verifies args `from`, `to`, state codes, `limit+1`), truncation (limit+1 rows returned → truncated true, len == limit), NULL failed_node → empty string, query error propagation. Follow the query-shape-regex + `t.Cleanup(ExpectationsWereMet)` conventions of `repository_sqlmock_test.go:12-73`.
- [x] **Step 2:** Run `go test ./pkg/plugin/slurm/ -run TestListNodeStatsJobs -v` — expect FAIL.
- [x] **Step 3:** Implement `ListNodeStatsJobs`; add `failed_node` to `jobSelectColumns`, `Job.FailedNode`, and `JobRecord.FailedNode`; update existing sqlmock column expectations accordingly.
- [x] **Step 4:** `go test ./pkg/... -v` — expect all PASS (including previously-existing tests you adjusted).
- [x] **Step 5:** Commit: `feat: query node failure stats and expose failed_node`

---

### Task 3: Service + handler + route

**Files:**
- Modify: `pkg/plugin/service.go` (interface + catalog method + payload types), `pkg/plugin/resources.go` (handler), `pkg/plugin/app.go` (route)
- Test: `pkg/plugin/service_test.go`, `pkg/plugin/resources_test.go` (extend)

**Interfaces:**
- Consumes: `ComputeNodeHealth` (Task 1), `ListNodeStatsJobs` (Task 2), existing `getCluster(clusterID, user)`.
- Produces (used by Task 4 — this is the wire contract, field names must match the spec's JSON example exactly):

```go
// JobRepository interface addition
ListNodeStatsJobs(ctx context.Context, from, to, limit int64) ([]slurm.NodeStatsJob, bool, error)

type NodeHealthPayload struct {
    Cluster   ClusterRef         `json:"cluster"`   // {id, name} — reuse/derive from existing cluster summary fields
    Window    NodeHealthWindow   `json:"window"`    // {from, to} unix seconds
    Baseline  NodeHealthBaseline `json:"baseline"`
    Truncated bool               `json:"truncated"`
    Nodes     []NodeHealthStats  `json:"nodes"`
}

func (s *CatalogService) NodeHealth(ctx context.Context, clusterID string, user *backend.User, from, to int64) (*NodeHealthPayload, error)
```

- Route: `mux.HandleFunc("GET /api/nodes/health", app.handleNodeHealth)` in `app.go:39-46`.
- Handler: parse `clusterId`, `from`, `to` query params; validate all present, integers, `from < to`; 400 on violation with the existing error-body shape; then `backend.UserFromContext` → `NodeHealth` → `writeJSON`, errors via `writeCatalogError` (unknown cluster → 404, forbidden → 403, consistent with existing handlers in `resources.go:42-96`).

- [x] **Step 1:** Write tests first:
  - `service_test.go`: authorized user gets payload (fake repository returning fixed `[]slurm.NodeStatsJob`); unauthorized user (AccessRule mismatch) → catalog access error; unknown cluster → not-found error; truncated flag propagates. Follow existing fake-provider patterns (`service_test.go:162-177`).
  - `resources_test.go`: 200 happy path with JSON field spot-checks (`nodes[0].name`, `baseline.failureRate`, `truncated`); 400 for missing/garbage/inverted `from`/`to`; 404 unknown cluster; 403 unauthorized. Follow `resources_test.go:755-825` conventions.
- [x] **Step 2:** Run `go test ./pkg/plugin/ -run 'NodeHealth' -v` — expect FAIL.
- [x] **Step 3:** Implement interface addition, catalog method (getCluster → repository → ComputeNodeHealth → payload), handler, route registration. Update any other fakes implementing `JobRepository`.
- [x] **Step 4:** `go test ./pkg/... -v` — expect all PASS.
- [x] **Step 5:** Commit: `feat: add GET /api/nodes/health endpoint`

---

### Task 4: Frontend Node Health page

**Files:**
- Create: `src/pages/NodeHealth/NodeHealthPage.tsx`, `src/pages/NodeHealth/api.ts`, `src/pages/NodeHealth/types.ts`, `src/pages/NodeHealth/viewJobsLink.ts`, `src/pages/NodeHealth/severity.ts`
- Modify: `src/components/App/App.tsx` (route regex for `/nodes` before Job Search fallback), `src/plugin.json` (`includes` page entry "Node Health", path `/a/yuuki-slurm-app/nodes`)
- Test: `src/pages/NodeHealth/viewJobsLink.test.ts`, `src/pages/NodeHealth/severity.test.ts`

**Interfaces:**
- Consumes: `GET /api/nodes/health` contract from Task 3 (mirror it in `types.ts`); existing cluster list fetch pattern and URL-sync query parameter names — read `syncFiltersToURL` in `src/pages/JobSearch/JobSearchPage.tsx` and reuse its EXACT parameter names for the deep link.
- Produces:

```ts
// severity.ts
export type Severity = 'critical' | 'warning' | 'ok';
// critical: score >= 5 && !lowSample; warning: score >= 1 && !lowSample; else ok
export function scoreSeverity(score: number, lowSample: boolean): Severity;

// viewJobsLink.ts — absolute app URL into Job Search, pre-filtered to the
// node name + time window + cluster, using syncFiltersToURL's param names.
export function buildViewJobsUrl(clusterId: string, node: string, fromMs: number, toMs: number): string;
```

Page behavior:
- Cluster selector (same `/api/clusters` fetch as Job Search), Grafana `TimeRangePicker` + the Job Search preset RadioButtonGroup, default last 7d. Note: `TIME_RANGE_PRESETS` in `src/pages/JobSearch/JobTimeline.tsx:42-49` is NOT exported — export it (or lift it into a small shared module) and reuse it; keep Job Search behavior unchanged.
- Table columns: Node | Jobs | Failed | NODE_FAIL | failed_node hits | Failure rate (inline bar) | Score (severity-colored Badge) | Last failure (reuse time formatting from `src/pages/JobSearch/jobTime.ts`) | View jobs link. JSX-defined columns in the `JobTable` style; `useStyles2`.
- `lowSample` rows greyed; `truncated` renders an inline `Alert` ("results based on the most recent 20,000 jobs"); fetch failure renders error `Alert`; empty result renders "No finished jobs in this window".

- [x] **Step 1:** Write Jest tests for `scoreSeverity` (boundary values 1 and 5, lowSample forces `ok`) and `buildViewJobsUrl` (assert exact query-param names against what `syncFiltersToURL` produces — read that code first, don't guess).
- [x] **Step 2:** `npx jest --testPathPattern=NodeHealth` — expect FAIL.
- [x] **Step 3:** Implement helpers, API client, page, routing, plugin.json entry.
- [x] **Step 4:** `npx jest --testPathPattern=NodeHealth` PASS; `npm test` PASS; `npm run typecheck` PASS; `npm run lint` PASS.
- [x] **Step 5:** Commit: `feat: add Node Health page with bad-node ranking`

---

### Task 5: Dev mock data enrichment

**Files:**
- Modify: `dev/metrics_common.py` (add `failed_node` to job dicts for the two NODE_FAIL jobs: `train_nodefail_large` → `gpu-node003`, `benchmark_nodefail_h100` → `h100-node02`; bias ≥5 existing FAILED jobs so their nodelists include `gpu-node003`)
- Modify: `dev/initdb/02_seed.sql` (add `failed_node` to the INSERT column list and values for jobs 10097/10098; update the biased FAILED jobs' nodelists consistently). If `02_seed.sql` is generated by a dev script, regenerate instead of hand-editing — check for a generator first.
- Modify: `e2e/initdb/03_e2e_seed.sql` (give one NODE_FAIL job a `failed_node` so e2e has deterministic data)

- [ ] **Step 1:** Check whether `02_seed.sql` is generated (`grep -rn "02_seed" dev/`); use the generator if one exists.
- [ ] **Step 2:** Apply the data changes; keep `metrics_common.py` and the SQL seed consistent (same jobs, same nodes).
- [ ] **Step 3:** Verify: `docker compose down -v && docker compose up -d`, wait for MariaDB init, then query the job table for rows with a non-empty `failed_node` (the compose service is named `mysql`, see `docker-compose.yaml:34-44` for credentials/db name — e.g. `docker compose exec -T mysql mysql -u<user> -p<pass> <db> -e "SELECT id_job, state, nodelist, failed_node FROM gpu_cluster_job_table WHERE failed_node IS NOT NULL AND failed_node != ''"`) — expect the two NODE_FAIL rows.
- [ ] **Step 4:** Commit: `feat: seed failed_node and bad-node bias in dev data`

---

### Task 6: Documentation

**Files:**
- Create: `docs/node-health.md` (user guide: what the page shows, how the score works in plain words, lowSample/truncated meaning, view-jobs link, Phase 2 note)
- Modify: `docs/overview.md` (add Node Health to the guide list), `README.md` (feature bullet + docs link), `CLAUDE.md` (add `GET /api/nodes/health` to the route list)

- [ ] **Step 1:** Write the docs; match the tone/structure of `docs/job-search.md`.
- [ ] **Step 2:** Verify every route listed in `CLAUDE.md` matches `pkg/plugin/app.go` exactly (this repo has had drift fixed before — commit 0403606).
- [ ] **Step 3:** Commit: `docs: add Node Health user guide and route listing`

---

### Task 7: E2E smoke test

**Files:**
- Create: `e2e/tests/node-health.spec.ts` (Playwright `testDir` is `./e2e/tests`, see `playwright.config.ts:32-34`; follow the conventions of existing specs there)

Test: navigate to `/a/yuuki-slurm-app/nodes`, wait for the ranking table, assert (a) the table has ≥1 row, (b) the seeded bad node from Task 5's e2e seed appears, (c) the View jobs link navigates to Job Search with the node filter applied.

- [ ] **Step 1:** Write the spec.
- [ ] **Step 2:** Run `npm run e2e:setup` (if browsers missing) then run the e2e suite the way `e2e/run.sh` does — it builds the frontend and backend BEFORE starting compose (`e2e/run.sh:16-21`); a stale build tests the wrong code. Expect the new spec to PASS.
- [ ] **Step 3:** Commit: `test: add Node Health e2e smoke test`

---

### Task 8: Full verification

- [ ] `go test ./pkg/... -v` — all PASS
- [ ] `npm test` — all PASS
- [ ] `npm run typecheck` && `npm run lint` — clean
- [ ] `mage -v build:linux` (or `build:darwin`) — builds
- [ ] Manual: `docker compose up -d`, open Grafana, confirm `gpu-node003` ranks first on a 7-day window, lowSample rows greyed, View jobs deep link works
- [ ] Report results honestly, including anything skipped or failing
