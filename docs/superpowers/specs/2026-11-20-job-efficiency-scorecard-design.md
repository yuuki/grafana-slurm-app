# Job Efficiency Scorecard — Design

Date: 2026-11-20
Status: Implemented (issue #122, part 1 and a bounded form of part 2)

## Overview

Issue #122 asks for two things:

1. A per-job scorecard that compares the allocation (`AllocTRES`) with
   telemetry: idle GPUs, GPU memory headroom, CPU and I/O bottlenecks.
2. A way to find the jobs that waste the most GPU-hours across a cluster,
   a user or a partition.

This document records what was built, the decisions behind it and their
reasons. `docs/job-efficiency.md` is the user guide and defines every score;
this document does not repeat the formulas.

## Decisions

### 1. The frontend computes the scores

The backend reads slurmdbd only. Every metrics query of the plugin goes from
the browser through Grafana's datasource proxy
(`/api/datasources/proxy/uid/<uid>/api/v1/...`): the Job Search utilization
columns, Metric Compare, metric discovery and the auto filter input. The
backend has no credentials for the datasource. Querying it from Go would
need a service account and a change to `src/plugin.json`.

So the scorecard follows the existing split:

- Backend: serves the allocation (`gpusTotal`, new `cpusTotal`) and the
  per-cluster efficiency settings. No new route.
- Frontend: plans the queries, sends them through the proxy, scores the
  result (`src/pages/JobDashboard/efficiency/`).

The scoring is pure TypeScript (`score.ts`) and is tested against a fake
metrics backend that evaluates the scorecard's query shapes
(`__fixtures__/fakeMetrics.ts`).

### 2. Unknown is not zero

A GPU, a bucket or a metric without telemetry is "no data". The allocated
GPU time is split three ways (active, idle, no telemetry), and the share
"GPU time in use" leaves the third part out of both numerator and
denominator. Each state in which nothing can be said has its own name
(`not-computed` reasons, `no-telemetry`, and per finding `inconclusive`,
`no-data`, `not-applicable`, `failed`). None of them is shown as OK.

### 3. Attribution by counting, with one-sided bounds

slurmdbd's job table does not record which GPUs or CPUs of a node a job
holds, and the exporters do not label series with the job. The plugin
selects a job's series by node list and time range, and the scorecard does
the same. It then compares counts:

- GPUs reporting on the nodes = GPUs allocated: exact.
- More reporting than allocated (shared nodes): only one-sided statements
  hold. At most `active` of the job's GPUs were active, so at least
  `allocated - active` were idle. The fullest GPU of the nodes bounds the
  job's fullest GPU from above. CPUs that are not busy node-wide are not
  busy for the job.
- Fewer reporting than allocated: the missing GPUs are "no telemetry".

Rejected: guessing the job's GPUs (for example the lowest indices), and
scoring shared nodes as if they were exclusive. Both would accuse users of
waste that the data does not show.

A job-label on the GPU series (for example dcgm-exporter's `hpc_job`) would
make shared nodes exact. It is not used because it depends on site setup
that cannot be verified here; it is the natural next step.

### 4. Buckets, and "active" by the bucket's highest sample

"Never exceeded the idle baseline" needs a baseline and a time resolution.

- The run is split into buckets that end at the job's end and never start
  before its start. This keeps the samples of the previous job on the same
  nodes out. The cost is that up to one bucket length at the start is not
  scored.
- A GPU is active in a bucket when `max_over_time` over the bucket exceeds
  the baseline. One sample marks the whole bucket. Idle time is therefore
  never overstated, and the "idle GPU" test is exact whatever the bucket
  length (the maximum over the job is the maximum of the bucket maxima).
- Range queries with a range selector as long as the step are used instead
  of one instant query over the whole job with a subquery, because they
  need only `*_over_time` and plain aggregation, which Prometheus and
  VictoriaMetrics evaluate alike.

### 5. Query cost is bounded by construction

- At most 7 queries per scorecard, sent one after another.
- Every query aggregates in PromQL (`max by (instance, gpu)`,
  `sum`, `count`). No raw samples are fetched.
- The per-GPU range queries return GPUs x buckets points. The bucket count
  is chosen so that this stays under 24,000 points. The GPU count is
  estimated before querying as `max(allocated GPUs, 8 x nodes)`, because a
  shared node reports more GPUs than the job allocated.
- A job that would exceed the budget with a single bucket is not scored.
- The CPU queries use a fixed 5-minute rate window at each bucket end. A
  node has many more CPU series than GPU series; sampling keeps the cost of
  these queries independent of the job's length.
- States that need no telemetry send no query. Queries whose result could
  not change a finding are skipped.

### 6. CPU metrics come from node_exporter, not from the configurable expression

The cluster setting `cpuUtilizationExpr` yields a percentage per node for
the Job Search column. The bottleneck finding needs idle and iowait
separately and in CPUs, to compare them with the job's allocated CPUs. The
default expression counts iowait as busy, which would report an I/O-bound
job as CPU-bound. The finding therefore reads
`node_cpu_seconds_total{mode="idle"|"iowait"}` directly. node_exporter is
already a requirement of the plugin. Without the metric the finding is "no
data". Telemetry that does not add up to one second per second and CPU (for
example one series per node) is refused instead of scored.

### 7. Settings: optional, per cluster, defaults in the frontend

Sites differ in exporter and label names, so the GPU metric names and the
GPU ID label are settings (`clusters[].efficiency`). The two thresholds the
issue names (idle baseline, low memory) are settings as well. The other
thresholds are constants in `score.ts` to keep the settings small; they can
become settings when a site needs it.

- The backend stores, validates and serves the object. It applies no
  defaults, because it does not use the values.
- Thresholds are optional numbers, so `0` is a value and "unset" is the
  default.
- A cluster that keeps every default stores and serves no `efficiency` key.
  Stored settings of existing installations do not change, in the
  multi-cluster shape and in the migrated legacy single-cluster shape.
- Metric names are restricted to the classic metric name characters,
  because they go into PromQL unquoted. The settings page and the backend
  apply the same rule.

### 8. Advice only where the evidence supports it

Each finding carries its evidence as numbers in a sentence. Advice appears
only for a Warning, and is derived from those numbers ("Request 4 instead
of 8"). Underused GPUs without a CPU or I/O cause get no advice: the
evidence (for example "1.3 of 16 CPUs were busy") is shown and the
conclusion is left to the reader.

## Compatibility

Additions only:

- `GET /api/jobs` and `GET /api/jobs/{clusterId}/{jobId}`: new field
  `cpusTotal` (0 when `AllocTRES` records no CPU count).
- `GET /api/clusters`: new optional field `efficiency`.
- Settings: new optional key `clusters[].efficiency`.

No route, cursor, settings key, template ID or `src/plugin.json` entry
changes. The slurmdbd columns read are unchanged: `cpusTotal` comes from
`tres_alloc`, which was read before.

## Departures from the issue

- **Power** is not part of the idle test. Idle power differs by GPU model,
  so no baseline holds for every cluster.
- **Allocated memory and walltime** are not compared with usage. Walltime
  needs a slurmdbd column the plugin does not read today; host memory is a
  node metric with the attribution limits described above.
- **Disk read wait** is measured as CPU time in `iowait`, which
  node_exporter exports on every Linux node, not per disk.
- **Part 2** is delivered as a column and a sort order in Job Search, not as
  a separate overview tab. See below.

## Part 2: idle GPU-hours in Job Search

Ranking jobs multiplies the query cost by the number of jobs. The bounded
form that was built:

- Job Search already loads jobs in pages of 100 and sends one CPU and one
  GPU utilization query per page. The idle GPU-hours add two queries per
  page: the GPUs reporting and the GPUs active, per node and bucket
  (`count by (instance) (max_over_time(...[step]) > baseline)`).
- nodes x buckets stays under 24,000 points per query. If that would need
  buckets longer than 30 minutes, the page's jobs are "not computed" and
  the user is asked to narrow the search.
- Each job is reduced from the buckets that lie fully inside its run, with
  the same accounting as the scorecard (`accumulateGpuTime`). The value is
  a lower bound of the scorecard's value: the buckets are longer and the
  edges are left out.
- The table can be sorted by idle GPU-hours. The order covers the loaded
  jobs only, and the page says so.

Not built: a cluster-wide ranking over all jobs of a time range, and sums
per user or partition. Both need either a query per job or pre-aggregated
data (recording rules or a table the backend maintains). A design for that
would start from a recording rule per node (`idle GPUs`, `reporting GPUs`)
and join it with the job table in the backend.

## Testing

- Go: table tests for the settings (both settings shapes), the CPU count
  parser and the served JSON; fuzz targets `FuzzParse` (extended) and
  `FuzzParseTRESCPUs`.
- Jest: window planning, query strings, the datasource client, scoring
  (table-driven, including no-data and partial-data cases), the scorecard
  end to end against the fake metrics backend, the sentences, the
  component and the settings editor.
- Manual: the scorecard was run against a real Prometheus 3.5, MariaDB and
  Grafana 12.4 with generated telemetry for 16 jobs (idle GPUs, shared
  nodes, CPU-bound, I/O-bound, running, no telemetry, retention gap).
