# Node Health (Bad Node Finder) — Design

Date: 2026-07-13
Status: Approved (Phase 1 scope)

## Overview

Add a new "Node Health" page that ranks compute nodes by how strongly they
correlate with job failures, so cluster operators can spot suspect nodes
("this node keeps killing jobs") from slurmdbd history alone.

- **Phase 1 (this design):** scoring from slurmdbd job failure history only.
  New backend API + new frontend page.
- **Phase 2 (future, sketch only):** overlay hardware-health metrics
  (DCGM temperature/power/utilization; ECC/Xid where exporters provide them)
  on a node detail view using the existing `buildInstanceMatcher` helper.

## Goals / Non-Goals

Goals (Phase 1):

- Rank nodes of a cluster within a user-selected time window by an
  explainable "excess failure" score.
- Surface the raw evidence next to the score: job counts, failure rate,
  `NODE_FAIL` involvement, exact `failed_node` hits, last failure time.
- Link each node to Job Search pre-filtered by that node and window.
- Work even when `failed_node` is not populated (it is absent from the dev
  seed and from many real deployments); treat it as a bonus signal.

Non-Goals (Phase 1):

- No Prometheus/DCGM queries (Phase 2).
- No node allocation/utilization view (this is failure correlation only).
- No scheduler actions (drain/undrain) — read-only analytics.

## Scoring

Definitions, computed over finished jobs in the window `[from, to]`
(jobs with `time_end` in the window; jobs with an empty `nodelist` are
skipped):

- Included states: `COMPLETED`, `FAILED`, `NODE_FAIL`. Failure states are
  `FAILED` (5) and `NODE_FAIL` (7); `COMPLETED` contributes to the
  denominator only. `TIMEOUT`, `CANCELLED`, `PREEMPTED` are excluded from
  both numerator and denominator — they are dominated by user/scheduler
  causes and would drown the node-fault signal.
- For a job `j` allocated to nodes `N_j`, each node receives fractional
  blame `w_j = 1 / |N_j|` (an 8-node failed job is weaker evidence against
  any single node than a 1-node failed job).

Per node `n`:

```
weightedJobs(n)      = Σ_{j : n ∈ N_j} w_j
weightedFailures(n)  = Σ_{j failed, n ∈ N_j} w_j
weightedNodeFails(n) = Σ_{j NODE_FAIL, n ∈ N_j} w_j
failedNodeHits(n)    = count of failed jobs where failed_node == n   (exact attribution, undivided)

p                    = Σ weightedFailures / Σ weightedJobs           (cluster baseline failure rate)
expected(n)          = weightedJobs(n) × p
excess(n)            = weightedFailures(n) − expected(n)

score(n) = excess(n)
         + NODE_FAIL_BONUS   × weightedNodeFails(n)
         + FAILED_NODE_BONUS × failedNodeHits(n)
```

Constants (Go code constants, not user-configurable in Phase 1):
`NODE_FAIL_BONUS = 2.0`, `FAILED_NODE_BONUS = 5.0`, `MIN_JOBS = 5`.

Display values per node additionally include the unweighted, human-readable
`totalJobs`, `failedJobs`, `failureRate = failedJobs / totalJobs`, and
`lastFailureAt`. Nodes with `totalJobs < MIN_JOBS` are flagged
`lowSample: true` and rendered de-emphasized (greyed) to limit
small-sample false positives; they are still listed.

Rationale: "observed minus expected" is a Poisson-style excess measure that
is robust to overall cluster-wide failure spikes (a bad software rollout
raises `p`, so no single node stands out), while the additive bonuses encode
that `NODE_FAIL` and `failed_node` are qualitatively stronger evidence.

## Backend

### New API

```
GET /api/nodes/health?clusterId={id}&from={unixSeconds}&to={unixSeconds}
```

`clusterId` is a query parameter, consistent with `GET /api/jobs`.
`from`/`to` are required; the handler validates `from < to`.

Response (nodes sorted by `score` descending server-side):

```json
{
  "cluster": { "id": "cluster-1", "name": "GPU Cluster" },
  "window": { "from": 1752000000, "to": 1752604800 },
  "baseline": { "totalJobs": 480, "failedJobs": 17, "failureRate": 0.0354 },
  "truncated": false,
  "nodes": [
    {
      "name": "gpu-node003",
      "totalJobs": 42,
      "failedJobs": 9,
      "nodeFailJobs": 1,
      "failedNodeHits": 1,
      "failureRate": 0.2143,
      "expectedFailures": 1.49,
      "score": 14.51,
      "lastFailureAt": 1752300000,
      "lowSample": false
    }
  ]
}
```

### Layering (follows existing pattern)

- `pkg/plugin/app.go`: register `GET /api/nodes/health` on the mux.
- `pkg/plugin/resources.go`: handler parses/validates params, gets the
  Grafana user via `backend.UserFromContext`, calls the catalog, writes JSON
  with the existing `writeCatalogError`/`writeJSON` helpers.
- `pkg/plugin/service.go`: `CatalogService.NodeHealth(ctx, clusterID, user,
  from, to)` goes through `getCluster(clusterID, user)` so cluster access
  rules apply (there is no mux-level auth middleware).
- `JobRepository` interface gains one lightweight method returning per-job
  rows for aggregation, e.g.:

  ```go
  // NodeStatsJob is the minimal projection needed for node failure stats.
  type NodeStatsJob struct {
      State      string
      NodeList   string // compressed notation, expanded in Go
      EndTime    int64
      FailedNode string
  }

  ListNodeStatsJobs(ctx context.Context, from, to int64, limit int) ([]NodeStatsJob, bool, error)
  ```

  The second return value reports truncation (fetch `limit+1` rows).
- `pkg/plugin/slurm/repository.go`: implements the query against the
  validated `<cluster>_job_table` with `?` placeholders only:
  `WHERE time_end >= ? AND time_end <= ? AND time_end > 0 AND state IN (?, ?, ?)`
  (COMPLETED, FAILED, NODE_FAIL) selecting
  `state, nodelist, time_end, failed_node`, `ORDER BY time_end DESC LIMIT ?`.
  Row cap: `LIMIT 20000` (constant); most recent jobs win on truncation.
  Note: the query fetches `COMPLETED` rows too, not just failures — totals
  per node are the denominator.
- Aggregation + scoring live in a pure function (new file, e.g.
  `pkg/plugin/nodehealth.go` or `pkg/plugin/slurm/nodestats.go`) that takes
  `[]NodeStatsJob` and returns the response payload. `nodelist` expansion
  uses `slurm.ExpandNodeList`; expansion errors are tolerated the same way
  `List` tolerates them (log a warning, treat the raw string as one node).
- Side product: add `failed_node` to `jobSelectColumns` and expose it as
  `FailedNode` on `slurm.Job` / `JobRecord` so the Job Dashboard metadata
  can show it later.

## Frontend

- New page `src/pages/NodeHealth/NodeHealthPage.tsx` (+ small components),
  following `useStyles2(getStyles)` + emotion conventions.
- Routing: add a `/nodes` regex branch in `src/components/App/App.tsx`
  before the Job Search fallback
  (URL: `/a/yuuki-slurm-app/nodes`).
- Navigation: add a `type: "page"` entry "Node Health" to
  `src/plugin.json` `includes`.
- Page layout:
  - Cluster selector (same `/api/clusters` fetch pattern as Job Search).
  - Grafana `TimeRangePicker` with the Job Search preset set; default 7d.
  - Ranking table (JSX-defined columns in the `JobTable` style):
    Node | Jobs | Failed | NODE_FAIL | failed_node hits | Failure rate
    (inline bar) | Score (severity-colored badge) | Last failure |
    "View jobs" link.
  - `lowSample` rows greyed; `truncated: true` renders an inline warning
    ("results based on the most recent 20,000 jobs").
- "View jobs" links to Job Search with the existing URL-sync query
  parameters (node name filter + time window + cluster), reusing the exact
  parameter names produced by `syncFiltersToURL`.
- State fetch failures render the standard error alert; an empty window
  renders an empty state ("No finished jobs in this window").

## Dev mock data

So the feature is demonstrable locally:

- Populate `failed_node` for the two existing `NODE_FAIL` jobs in
  `dev/metrics_common.py` and `dev/initdb/02_seed.sql`
  (e.g. `gpu-node003` for job 10097, `h100-node02` for job 10098).
- Bias several existing `FAILED` jobs so their nodelists include
  `gpu-node003`, making it the visibly "bad" node in the ranking.
- Keep `dev/generate-metrics.py` output consistent with the seed
  (both derive from `metrics_common.py`).

## Testing

- Go: table-driven unit tests for the scoring function (fractional blame,
  baseline, bonuses, lowSample, truncation flag, empty nodelist skip,
  expansion-error tolerance); sqlmock test for the new repository query
  (query-shape regex + `WithArgs` + cleanup verification); service/handler
  tests covering unauthorized user, unknown cluster, and bad params.
- Frontend: Jest tests for score/severity rendering helpers and the
  "View jobs" URL builder; `npm run typecheck`.
- E2E: one Playwright smoke test — page loads, ranking table renders with
  the seeded bad node on top.
- Manual: `docker compose up -d` + seeded data; verify `gpu-node003` ranks
  first over a 7-day window.

## Documentation

- New `docs/node-health.md` user guide; link it from `docs/overview.md`
  and the README feature list.
- Update the API route list in `CLAUDE.md` (and `docs/` where routes are
  enumerated) with `GET /api/nodes/health`.

## Phase 2 sketch (not in scope)

Node detail drawer on row click: DCGM temperature/power/utilization panels
scoped to the node via `buildInstanceMatcher` (`src/pages/JobDashboard/scenes/model.ts`),
plus ECC/Xid error counters where the deployment's exporters provide them
(the dev environment currently does not). May also fold in
`gpu_cluster_step_table`-based per-step attribution if needed.

## Risks / Notes

- `failed_node` semantics are not specified in this repo's schema dump; in
  real slurmdbd it holds the node Slurm blamed for a `NODE_FAIL`. The design
  only rewards exact matches and degrades gracefully when NULL/empty.
- Multi-node failed jobs dilute blame by construction (`1/|N_j|`); a truly
  bad node still accumulates excess across many jobs.
- The 20,000-job cap keeps memory bounded; `truncated` is surfaced in the
  UI rather than silently dropped.
- Compressed `nodelist` cannot be aggregated in SQL; expansion happens in Go
  exactly like the existing node-name filter path.
