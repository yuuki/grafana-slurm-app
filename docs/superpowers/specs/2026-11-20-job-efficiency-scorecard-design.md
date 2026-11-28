# Job Efficiency Scorecard — Design

Date: 2026-11-20, revised 2026-11-21 after an adversarial review
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

- Backend: serves the allocation (`gpusTotal`, new `cpusTotal`), what
  slurmdbd knows about the run (`suspendedSeconds`, `timeLimitSeconds`) and
  the per-cluster efficiency settings. No new route.
- Frontend: plans the queries, sends them through the proxy, scores the
  result (`src/pages/JobDashboard/efficiency/`).

The scoring is pure TypeScript (`score.ts`) and is tested against a fake
metrics backend that evaluates the scorecard's query shapes
(`__fixtures__/fakeMetrics.ts`).

### 2. Unknown is not zero, and a fact needs proof

The rule of the scorecard: a number or a sentence about idleness or a
bottleneck is shown as a fact only when the telemetry provably belongs to
the job and covers it. Otherwise the finding is Inconclusive, or says that
there is no telemetry, and names what is missing.

A GPU, a node, a bucket or a metric without telemetry is "no telemetry".
The allocated GPU time is split three ways (active, idle, no telemetry),
and the share "GPU time in use" leaves the third part out of both numerator
and denominator. Each state in which nothing can be said has its own name
(`not-computed` reasons, `no-telemetry`, and per finding `inconclusive`,
`no-data`, `not-applicable`, `failed`). None of them is shown as OK.

A verdict has two sides. A Warning needs a proven lower bound (the idle
share of the whole allocation, the share of windows with a bottleneck). An
OK needs the upper bound to stay under the threshold when everything
without telemetry is counted against the job. Between the two the finding
is Inconclusive and states both bounds.

### 3. Attribution per node, with one-sided bounds

slurmdbd's job table does not record which GPUs or CPUs of a node a job
holds, nor how the job's GPUs are spread over its nodes, and the exporters
do not label series with the job. The plugin selects a job's series by node
list and time range, and the scorecard does the same. It then decides per
node whether the GPUs that report can be the job's (`attributeGpus`):

- exact: every node of the job reports, and the GPUs add up to the
  allocation. The job then holds every GPU of its nodes.
- shared: every node reports, and the nodes hold more GPUs. Only one-sided
  statements hold, and only in buckets in which every GPU of every node
  reports: at most `active` of the job's GPUs were active, so at least
  `allocated - active` were idle. The fullest GPU of the nodes bounds the
  job's fullest GPU from above. CPUs that are not busy node-wide are not
  busy for the job.
- unknown: a node of the job reports no GPU, or fewer GPUs report than
  allocated. Nothing is counted for the job. The job's share of a node that
  reports depends on what it holds on the nodes that do not.

The first version compared only the total number of reporting GPUs with
the allocation, for the window and again per bucket. A node without an
exporter next to a shared node then made the other node's unused GPUs the
job's, as exact numbers; an exporter outage or two nodes scraped out of
phase did the same per bucket. The review reproduced both on a real
Prometheus. Counting per node closes them.

The model keeps one assumption: an exporter reports every GPU of its node
or none. The telemetry can check it only in part. When the GPU IDs of a
node are numbers and leave gaps (only 4 to 7, or 0, 1, 3), some of its GPUs
do not report, and the node counts like a silent one. The second review
showed the case this closes: a node that reports only another job's idle
GPUs, with a total that equals the allocation by chance. A GPU missing at
the end of the range, and IDs that are not numbers, stay undetected; the
user guide gives an example. The Job Search batch counts GPUs per node
without IDs and cannot make this check.

A GPU counts as idle when it never exceeded the baseline in a bucket with
telemetry and has telemetry for at least 95% of the buckets; the finding
states how many buckets that is and claims nothing about the others. A GPU
with less telemetry is listed as having gaps. The rework first demanded a
sample in every bucket. The second review measured what that costs: one
lost scrape in a two-hour job, or an exporter restart of three minutes,
withdrew the central finding ("Request 4 instead of 8"). 95% allows one
bucket in twenty and still refuses a scrape interval longer than the
buckets, longer outages and retention gaps. The same share applies to the
memory telemetry behind "every GPU stayed below 15%". Series of nodes
outside the job's node list are ignored.

Rejected: guessing the job's GPUs (for example the lowest indices), and
scoring shared nodes as if they were exclusive. Both would accuse users of
waste that the data does not show.

A job-label on the GPU series (for example dcgm-exporter's `hpc_job`) would
make shared nodes exact. It is not used because it depends on site setup
that cannot be verified here; it is the natural next step.

### 4. Buckets, and "active" by the bucket's highest sample

"Never exceeded the idle baseline" needs a baseline and a time resolution.

- The run is split into buckets that lie inside the job's run. This keeps
  the samples of the jobs before and after it on the same nodes out.
- From ten buckets on, the bucket boundaries are multiples of the bucket
  length. A backend that aligns range queries to the step for its cache
  (VictoriaMetrics does so from 50 points on) then evaluates exactly the
  buckets that were asked for. The parser drops samples that are not on
  the grid instead of guessing their bucket. The cost is that up to one
  bucket length at each end of the job is not scored; the section states
  how much. Windows with fewer than ten buckets stay unaligned, because
  there the lost bucket would be a large part of the job.
- A GPU is active in a bucket when `max_over_time` over the bucket exceeds
  the baseline. One sample marks the whole bucket. Idle time is therefore
  never overstated, and the "idle GPU" test is exact whatever the bucket
  length (the maximum over the job is the maximum of the bucket maxima).
- Range queries with a range selector as long as the step are used instead
  of one instant query over the whole job with a subquery, because they
  need only `*_over_time` and plain aggregation, which Prometheus and
  VictoriaMetrics evaluate alike.

### 5. Query cost is bounded by construction

- 8 queries per scorecard, sent one after another; 9 when the first
  response shows more GPU series than estimated (see below). An
  `AbortSignal` stops the queries that were not sent yet when the page is
  left.
- Every query aggregates in PromQL (`max by (instance, gpu)`,
  `sum by (instance)`, `count by (instance)`). No raw samples are fetched.
- The per-GPU range queries return GPUs x buckets points. The bucket count
  is chosen so that this stays under 24,000 points. The GPU count is
  estimated before querying as `max(allocated GPUs, 8 x nodes)`, because a
  shared node reports more GPUs than the job allocated. The estimate can be
  too low (nodes with more than 8 GPUs). When the first response holds more
  series than estimated, the window is planned again for the true number
  and the first query is repeated, so only that first response can exceed
  the budget.
- A job whose nodes report more than 24,000 GPU series is not scored.
- GPU memory is read per bucket, like utilization, not with one range
  selector over the whole job: one evaluation then loads one bucket of
  samples, whatever the job's length. The per-bucket data also shows where
  the memory telemetry has gaps.
- The CPU and I/O finding reads 5-minute windows inside the scored window:
  one after the other for buckets up to 5 minutes, one at the end of each
  longer bucket. A node has many more CPU series than GPU series; a fixed
  window keeps the cost of these queries independent of the job's length.
  GPU utilization is read in the same windows by a query of its own, so
  both sides of the comparison cover the same time. The first version
  evaluated the 5-minute rate at the end of every one-minute bucket; the
  first windows then reached back before the job's start and read the CPU
  time of the job before.
- No CPU window begins sooner than 75 seconds after the job's start. The
  second review showed on VictoriaMetrics that a window inside the job is
  not enough: MetricsQL's `rate()` starts from the last sample before the
  window, so a window that begins with the job reads one scrape interval
  of the job before. The rule does not depend on the configured backend
  type, because a store set up as Prometheus may evaluate like MetricsQL.
  75 seconds cover a scrape every 60 seconds; for slower scrapes a window
  counts only when it begins at least 300 / (n - 1) seconds into the job,
  where n is the fewest samples a CPU series holds in it. The third CPU
  query therefore returns the CPU series by their number of samples
  (`count_values` over `count_over_time`) instead of a plain count. Cost:
  no window, and no verdict, for jobs shorter than 6 minutes 15 seconds.
- States that need no telemetry send no query. Queries whose result could
  not change a finding are skipped.
- A response that is not a complete Prometheus API result is a failed
  query, not an empty one.

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

The CPU queries are grouped by node. A window counts only when every CPU of
every node of the job reports in it (a node's CPU count is the most CPUs
that reported in one window), and the job holds its nodes only when its CPU
allocation equals their sum. A node without CPU telemetry makes the finding
Inconclusive. A few 5-minute samples of a long job decide nothing: a
verdict needs 12 windows, or windows that cover half of the scored window.

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
- `disabled: true` turns job efficiency off for a cluster: no scorecard, no
  idle GPU column, none of their queries. It exists because an upgrade
  otherwise adds queries to every Job Search page and every opened GPU job
  with no way to stop them, and because a cluster whose telemetry does not
  meet the assumptions of decision 3 should not show the findings at all.
  The default is on; the zero value of the field keeps old settings
  unchanged.
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

- `GET /api/jobs` and `GET /api/jobs/{clusterId}/{jobId}`: new fields
  `cpusTotal` (0 when `AllocTRES` records no CPU count),
  `suspendedSeconds` (0 never suspended, -1 suspended for a time that
  slurmdbd does not hold as a duration) and `timeLimitSeconds` (0 no
  limit).
- `GET /api/clusters`: new optional field `efficiency`.
- Settings: new optional key `clusters[].efficiency`, with the optional
  switch `disabled`.

No route, cursor, existing settings key, template ID or `src/plugin.json`
entry changes. `cpusTotal` comes from `tres_alloc`, which was read before.
Two more columns of the job table are read: `time_suspended` and
`timelimit`. Both are older than `tres_alloc`, so no job table that the
plugin can read lacks them.

### 9. Suspended and runaway jobs are not scored

The scorecard treats every second between a job's start and end as the
job's. That is false for a job that was suspended (it holds its allocation
without running, and its GPUs may run another job meanwhile; the plugin
reads only the total from the job table, not the intervals, which slurmdbd
keeps in `<cluster>_suspend_table`) and for a job whose end slurmdbd missed (a
runaway job, recorded as running on nodes that run other jobs). Both are
refused with a reason instead of scored. The meaning of `time_suspended`
was checked against Slurm's source (`as_mysql_suspend` writes "time of the
event - previous value" on every suspend and resume; `sacct` reads the
column of a suspended job as "now - value"): it is a total only when the
job is not suspended, and a value written by a suspend is at least the
job's start time. A runaway job is recognised only
by being recorded as running more than one hour past its time limit; one
without a limit cannot be told from a running job, which the user guide
lists as a limitation.

A running job is scored up to two minutes before now. With "idle" requiring
a sample in every bucket, the newest bucket would otherwise make every GPU
of a running job a GPU with gaps.

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
  buckets longer than 6 hours, the page's jobs are "not computed" and the
  user is asked to narrow the time range. (The first version stopped at 30
  minutes, so a job longer than 10.4 days could never be ranked. Longer
  buckets weaken the lower bound but do not make it wrong; the limit stays
  because it bounds what one batch reads.)
- Each job is reduced from the buckets that lie fully inside its run, with
  the same attribution and accounting as the scorecard (`attributeGpus`,
  `accumulateGpuTime`). A node's GPU count is the most GPUs that reported
  in one of the job's buckets. A job whose reporting GPUs cannot be matched
  to it gets "n/c" with the reason, never a number. The value is a lower
  bound of the scorecard's value: the buckets are longer and the edges are
  left out.
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
- Jest, after the review: one regression test per reproduced defect, at the
  level of the scoring, of the scorecard against the fake metrics backend,
  of the sentences and of the Job Search batch (a node without exporter
  next to a shared node, an exporter outage, nodes scraped out of phase, a
  job after a job with high I/O wait or saturated CPUs, nodes with more
  GPUs than estimated, a job of several weeks, a share just under a
  threshold, a foreign or partial response, an unmounted section).
- Manual: the scorecard was run against a real Prometheus 3.5, MariaDB and
  Grafana 12.4 with generated telemetry for 16 jobs (idle GPUs, shared
  nodes, CPU-bound, I/O-bound, running, no telemetry, retention gap), and
  after the review against the reviewer's generated series with a known
  truth on a real Prometheus 3.5. After main moved to Grafana 13, the
  scorecard, the Job Search column, the settings editor and the off switch
  were checked again on Grafana 13.3.1 with the same data. The author did
  not run it against VictoriaMetrics; the reviewer ran the first version
  against VictoriaMetrics 1.102.
