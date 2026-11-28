# Job Phase Segmentation — Design

Date: 2026-11-28
Status: Implemented (issue #121)

## Overview

Issue #121 asks for two things:

1. Segment a job's timeline into regimes from GPU power and utilization,
   CPU utilization, disk write throughput and network bandwidth: startup,
   compute + collective, checkpoint / storage I/O, stalled.
2. Show a breakdown bar with the time per phase on the Job Dashboard, and
   optionally overlay the phase windows on panels or export them as draft
   region annotations.

This document records what was built, the decisions behind it and their
reasons, where it departs from the issue, how it was verified and what is
known to be weak. `docs/job-phases.md` is the user guide and defines every
label and threshold; this document does not repeat the rules.

The code is in `src/pages/JobDashboard/phases/` (`segment.ts` is the
algorithm), `src/pages/JobDashboard/components/JobPhasesSection.tsx` and
`pkg/plugin/settings/phases.go`.

## Decisions

### 1. The frontend segments the timeline

The issue allows the Go backend or the MetricSifter sidecar.

The backend reads slurmdbd only. Every metrics query of the plugin goes from
the browser through Grafana's datasource proxy
(`/api/datasources/proxy/uid/<uid>/api/v1/...`): the Job Search utilization
columns, Metric Compare, metric discovery, the auto filter input. The backend
has no credentials for the datasource. So the telemetry of a job arrives in
the browser whatever runs the algorithm.

- **Go backend, rejected.** The browser would fetch the series and post them
  to a new route, as the auto filter does for the sidecar. That adds a route
  and a JSON contract, and moves megabytes to the backend, which knows
  nothing the browser does not. Querying the datasource from Go instead
  would need a service account and a change to `src/plugin.json`.
- **Sidecar, rejected.** It is an optional component that most installations
  do not run, the feature would depend on it, and its test target cannot
  run in the environment this was built in, so the result could not have
  been verified.
- **Frontend, chosen.** No new route, no upload, the same split as the rest
  of the plugin.

The price: the algorithm is not available to other clients of the backend.
To keep that door open, `segmentPhases()` is a pure function without any
dependency: matrices in, labels out. Porting it to Go is a translation.

### 2. Rules on job-relative levels, not a statistical model

The issue says "unsupervised regime detection". Two readings were
considered.

- **Change-point detection or clustering first, labels second** (PELT,
  k-means, HMM). Rejected. The regimes of the issue are defined by
  conditions on named signals ("GPU power drop + sustained disk write
  spike"), so the segments would need the same rules afterwards anyway.
  A model adds parameters that need data to tune (a penalty, a number of
  states), merges the short segments that matter most (a checkpoint of two
  buckets), and cannot answer "why is this stretch a checkpoint?".
- **Rules per bucket on levels taken from the job itself**, chosen. It is
  unsupervised in the sense that matters to the user: nothing is trained
  and no absolute level is configured for power. Each label follows from a
  short list of stated conditions, which the section shows with the
  thresholds of the job.

A two-class split of the power distribution (Otsu, 2-means) was tried on
paper for the working level and rejected: with one class much larger than
the other it cuts the large class in half instead of finding the small one,
and a 2-minute checkpoint in a 10-hour job is exactly that case. The working
level is a high percentile instead (decision 5).

### 3. Honest output

The rule: a label is a claim, and a claim needs the telemetry that supports
it. What cannot be claimed is said to be unknown.

- A bucket has exactly one of six labels. Four are phases. **Unclassified**
  means GPU telemetry exists and fits no phase; it always carries one of
  eight reasons. **No GPU data** means no node reported. Neither is folded
  into a phase.
- The buckets tile the analysed window, so the shares add up. They are
  printed with one decimal by the largest-remainder method and add up to
  100.0. A label that exists but rounds to nothing is printed as "<0.1%",
  never as 0.0%; the other shares then still add up to 100.0.
- The fourth phase is displayed as "Stalled (GPUs idle)". The label names
  what was observed, because a hang and a job that waits for its user give
  the same telemetry.
- A signal that is missing is left out, never read as zero. Without a
  storage write series no checkpoint is reported; without utilization no
  stall; the section names the missing signal and the consequence.
- A job that cannot be analysed gets a sentence, not a bar (too short, no
  GPU telemetry, shared nodes, too many nodes).
- A query that fails is an error of the whole section, for every query: the
  probes, the GPU queries and the CPU, storage and network queries. The
  section names what the query reads and the cause, offers Retry, and shows
  no phases. An earlier version continued without a CPU, storage or network
  query that failed; a failed CPU query then had the effect of "no CPU
  series" and CPU-only work was reported as a stall.
- A response that is not a complete Prometheus API result of the expected
  type (an HTML login page, a partial result, warnings) is a failed query,
  not an empty one.
- A job whose GPUs never reach a working level is wholly unclassified with
  the reason "nothing to compare with". It is not "stalled": a stall is a
  job that computed and stopped.

### 4. The physics decide the resolution

Samples arrive at the scrape interval. A rate needs two samples in its
window and is noisy with two, and a mean of one sample is that sample.

- A bucket holds at least four scrape intervals and is at least one minute.
  The scrape interval is **measured**, not configured: instant queries
  count the samples of the series in ten minutes of the run, and the series
  with the most samples gives the interval. A value within 15% of a common
  interval (15 s, 30 s, 60 s, ...) is taken to be it, so one missed scrape
  does not double the bucket. When nothing can be measured, 30 s is assumed
  and the section says so.
- The bucket follows the **slowest of the GPU, CPU and storage write
  series**. The first version measured only the GPU and CPU series. With a
  storage counter scraped every 60 s beside exporters scraped every 15 s,
  the one-minute bucket held one storage sample; `rate()` over it is empty
  on Prometheus, so Prometheus showed "no series" where VictoriaMetrics
  (whose `rate()` reaches back to the sample before the window) found the
  checkpoint. One probe now counts the samples of every counter per metric,
  and the rate window is the bucket, so every bucket holds four samples of
  the slowest counter that decides a label. The network counters are
  probed too, but do not lengthen the bucket: network decides no label.
- A counter whose series exist but whose samples are too far apart for a
  rate in any bucket has the state **"too few samples"**, not "no series".
  This remains possible when the interval is longer than five minutes (it
  cannot be measured in a probe of ten minutes); the two backends then
  differ, as the user document states.
- Rejected: a fixed 5-minute rate window, as the plugin's panels use. It
  would smear a 2-minute checkpoint over five minutes. Rejected: the
  datasource's configured scrape interval, which is often left at its
  default.
- The range selector of every query is exactly one bucket, evaluated at the
  bucket's end, so the windows do not overlap and one point is one bucket.
- Bucket boundaries are multiples of the bucket length. VictoriaMetrics
  aligns range queries to the step for its cache (from 50 points on); with
  aligned boundaries both backends evaluate the buckets that were asked
  for. A point of a response that is not on the grid is dropped and
  counted, never assigned to a guessed bucket. The price: less than one
  bucket at each end of the run is not analysed, and a job needs five
  buckets inside its run (up to six bucket lengths).
- What this cannot see is stated in the user guide and in the section
  itself: a stretch much shorter than a bucket, boundaries finer than a
  bucket, collective bursts inside a step, evaluation on the GPUs.
  "Compute + collective" is one label for that reason, and network decides
  no label (decision 8).

### 5. Thresholds: relative to the job, except where a unit is universal

Absolute watts do not transfer between GPU models, and a power-capped job
must not read as idle.

- **GPU power is used only as a ratio to the job's working level.** No
  threshold is in watts, and the result does not change when every power
  value is multiplied by a constant (a property test checks this).
- **The working level** is the 90th percentile of the node buckets that are
  not proven idle, for power and for utilization. Leaving the idle buckets
  out matters: a job that computes for 2% of its run and then hangs with
  idle GPUs still gets the level of its compute, so the hang is found. This
  holds only when the GPUs are idle (at most 5%) in the hang. When they stay
  above the idle threshold (3 minutes of compute, then 3 hours at 12%
  utilization), the hang's buckets are the active buckets, the working
  level is the hang's level, and the hang is reported as compute. A node works when
  both signals reach half of the level; using both catches a power-capped
  job (power barely moves, utilization halves) and a GPU that spins at full
  utilization at idle power.
- **Idle is absolute, on utilization**: no sample of any GPU of the node
  above 5% in the bucket. A percentage means the same on every model, and
  the maximum over the bucket never overstates idleness. This anchor is
  what tells "low because this job is light" from "idle".
- **The stall time** (10 minutes) tells a stall from an idle stretch
  between steps. It is the one threshold that depends on the workload, so
  it is a setting.
- **The idle run is found from the GPUs alone, then decided as a whole.**
  A run of idle buckets that lasts for the stall time is a stall when the
  CPUs are idle too, and a checkpoint when the write rate is a burst in
  more than half of its buckets. An earlier version labelled each bucket
  first and counted only the unclassified ones towards a stall: one written
  bucket then split a hang, and a node that wrote for a minute every nine
  minutes hid a hang of an hour.
- **A stall needs CPUs that are clearly idle.** The median CPU load of the
  idle run must be below a quarter of the compute-time median, with the
  limit kept between 1% and 5% of CPU time. The relative part keeps a
  stretch that is near the job's own working level out of "stalled"; the
  5% cap keeps a job with busy CPUs during compute from calling a
  fifth of that load idle; the 1% floor is the background load of a node,
  below which a comparison with a small compute-time load is noise. An
  earlier version asked only for "less busy than during compute":
  post-processing at 54% after compute at 60% was a stall. Without CPU
  telemetry no stall is reported, because idle CPUs cannot be shown.
- **A write burst** is three times the job's own compute-time median, with
  an absolute floor of 1 MiB/s over the job's nodes. Without the floor, a
  job that writes nothing while computing would turn every log line during
  a GPU dip into a checkpoint. The floor is a setting.
- Settings: idle threshold, stall time, smallest write rate. The other
  numbers are constants in `segment.ts`.

Known cost of the 90th percentile: a job with short bursts far above its
steady level (more than twice) has the steady level reported as "GPUs below
the working level", unclassified. No estimator from one job's data can tell
"burst over steady work" from "work over idle spinning"; the percentile and
its consequence are documented.

### 6. Many nodes: aggregate in the backend, vote in the browser

- Every query aggregates per node in PromQL (`avg by (instance)`,
  `max by (instance)`, `sum by (instance)`). A response holds one series
  per node, whatever the number of GPUs, CPUs or devices.
- A node is classified per bucket; the job's state is a vote. Compute needs
  more than half of the job's nodes working. "Every GPU idle" needs every
  node of the job to report and be idle. Nodes without telemetry count for
  neither side, so a silent node can prevent a claim but never make one.
- One stalled node of 64 leaves the job in compute and produces a finding
  that names the node and the time. The percentages are about the job; the
  finding is about the node.
- Rejected: classifying the mean over all nodes. A stall of half the nodes
  would then look like a job at half power.
- **Cost bound.** At most 10 queries per job (up to 4 instant probes, 6
  range queries), sent one after another, cancellable. nodes x buckets
  stays under 24,000 points per response, at most 1,440 buckets. A job that
  cannot give a result sends as few queries as possible (the user document
  lists the counts). What is not bounded by a constant: the backend reads
  the raw samples of the job's window once per query, which grows with
  GPUs x duration, like any aggregated panel over the job's range.
- **Query length.** A query names every node, and the first version put
  the node matcher into the CPU query twice and into the network query
  four times. VictoriaMetrics refuses a query over 16,384 bytes by default,
  so a job of 300 nodes lost its network query and a job of 1,500 nodes
  its first probe. Now the CPU query names the nodes once
  (`1 - avg by (instance) (sum by (instance, cpu) (rate(...)))`), and any
  query over 12,000 characters is sent as several queries for disjoint
  parts of the nodes (`splitToFit`). Every query aggregates per node, so
  the parts are put together without any arithmetic. The number of
  requests therefore grows with the node count: 80 for 2,000 nodes.
- **Node limit: 2,000.** The point budget must leave at least 12 buckets
  per node. Rounding the bucket length up to a usual step can double it,
  and aligning the buckets costs one more; 12 / 2 - 1 leaves the 5 buckets
  that a result needs. The first version allowed 4,800 nodes (5 buckets
  before rounding), so every job of 3,500 nodes or more was refused as
  "too short", which named the wrong cause. Up to 2,000 nodes a job is too
  short exactly when a one-node job with the same run is (a test checks
  this on random runs). 2,000 nodes with full telemetry were run on both
  backends.

### 7. No result for a job on shared nodes

slurmdbd does not record which GPUs of a node a job holds, and the
exporters do not label series with the job. The queries select by node.

The first version only counted the GPUs and showed the count. Run against a
real Prometheus, a job that held 4 of the 8 GPUs of its node was reported as
100% compute while it was idle, because another job kept the other four GPUs
busy and the node average stayed above half of the working level. A caveat
next to a wrong bar is not honest. Now a job whose nodes report more GPUs
than it allocated gets no result, with that reason, after the GPU probes.

The GPUs per node are counted in up to three windows of ten minutes (end of
the run, ten minutes after its start, its middle), and a node's count is
the median of the windows in which it reports. The first version looked at
the end of the run only: a node whose GPU exporter was silent there was not
counted, and a job that held 4 of 8 GPUs on each of three nodes passed the
check and showed another job's load as compute. The median also keeps an
exporter restart, which shows every GPU twice in one window, from refusing
the job.

Rejected: guessing the job's GPUs; reporting only the one-sided claims that
survive sharing (idle is still provable, compute is not), which gives a bar
of little use.

When Slurm records no GPU count for the job (GRES not in
`AccountingStorageTRES`), the check is impossible; the analysis runs and the
notes say that it could not be checked. When fewer GPUs report than were
allocated, the analysis runs on those and says so. A job label on the GPU
series (dcgm-exporter's `hpc_job`) would lift the restriction; it depends on
site setup and is the natural next step.

### 8. Signals and queries

| Signal | Query shape | Role |
|--------|-------------|------|
| GPU utilization, maximum | `max by (instance) (max_over_time(U[b]))` | proves idle |
| GPU utilization, mean | `avg by (instance) (avg_over_time(U[b]))` | working level |
| GPU power, mean | `avg by (instance) (avg_over_time(P[b]))` | working level |
| CPU load | `1 - avg by (instance) (sum by (instance, cpu) (rate(cpu{mode=~"idle|iowait"}[b])))` | a stall needs idle CPUs |
| Storage write | `sum by (instance) (rate(W[b]))` | checkpoint |
| Network | `sum by (instance) (rate(N[b]))`, without `lo` | evidence only |

- **CPU counts neither idle nor iowait as busy.** A job blocked on a dead
  mount would otherwise look busy. Values outside 0..1 (a generator that
  writes one CPU series per node) make the signal unusable instead of
  wrong.
- **Network decides nothing.** At bucket resolution it cannot show the
  "periodic RDMA bursts" of the issue. It was considered as evidence for a
  checkpoint to a network file system (a transmit burst) and rejected: the
  same port carries the collective traffic, so the label would rest on a
  guess. It is shown per phase so that a reader can use it.
- **Storage write is a list of counters**, because checkpoints go to
  different storage on different sites; the default covers local disks.
- **Several counters in one query.** The first version put them into one
  selector (`{__name__=~"a|b"}`) inside `rate()`. Prometheus refuses that
  with "vector cannot contain metrics with the same labelset" as soon as
  two metrics share their labels (receive and transmit bytes of one
  interface), because `rate()` drops the name. Each counter now has its own
  `rate()`, marked with `label_replace`, joined by `or`. Found by running
  against a real Prometheus; the in-repo fake backend of the tests could
  not have found it.
- Evidence per phase is a median, not a mean: the buckets where two phases
  meet would pull a mean far off.

### 9. Settings: per cluster, opt-in, validated on both sides

- `clusters[].phases`, because metric names belong to a cluster like the
  other metric settings.
- **Off unless `phases.enabled` is true.** An upgrade must not add queries
  to every opened job, or a new section to every Job Dashboard, for sites
  that did not ask for them. A cluster that does not use the
  feature keeps no `phases` key and serves the same `/api/clusters` JSON as
  before, in the multi-cluster shape and in the migrated legacy shape; the
  legacy shape has no place for the settings, so the feature is off for it.
- The backend stores, validates and serves the object and applies no
  defaults, because it does not use the values. The defaults live in
  `phases/settings.ts`.
- Metric names are restricted to the classic metric-name characters because
  they go into PromQL unquoted. The settings page, the backend and the
  query builder each check them; the Job Dashboard sends no query for
  settings that fail.
- Thresholds are optional numbers, so `0` is a value and unset is the
  default.
- Rejected: a global top-level key (smaller diff, but one setting for
  clusters with different exporters).

### 10. Annotations: a draft, written only by the user

The issue makes the overlay and the export optional.

- Built: each row of the Stretches table has **Label…** when Annotation
  Labeling is enabled. It opens the existing label dialog with the window,
  the category `phase-<label>` and a note. The dialog shows the exact tags.
  Nothing is written before **Save label**; this was checked in a real
  Grafana by recording the requests (none before Save or after Cancel, one
  `POST /api/annotations` after Save). A saved label is an ordinary label:
  listed, drawn on the panels, deletable.
- The category has no colon. `phase:stalled` was tried first: Grafana
  stored `slurm-app:category=phase`, not what the dialog previewed, because
  it splits a tag at colons and drops what follows a second one.
- Clicking a stretch zooms the panels to it. That changes only the view.
- Not built: an overlay of unsaved phase windows on the panels (it needs a
  custom Scenes data layer and a rebuild of the scene that reruns every
  panel query), and saving several stretches at once (one click would write
  dozens of annotations).

### 11. Nothing changes for those who do not use it

- With the feature off (the default) the Job Dashboard renders and queries
  as before. Checked in the browser: no section, no phase query.
- No route, cursor, template ID, existing settings key or `src/plugin.json`
  entry changes. Additions only: the optional key `clusters[].phases` and
  the optional field `phases` of `GET /api/clusters`.
- The exported dashboard JSON is not touched. The sidecar is not touched.

## Departures from the issue

- **Runs in the frontend**, not in the Go backend or the sidecar
  (decision 1).
- **Rules, not a statistical regime model** (decision 2).
- **Startup is not defined by "high CPU / metadata I/O".** It is the time
  before the GPUs first reach the working level. Metadata I/O is not in the
  standard exporters, and startup with low CPU (waiting for weights from a
  network file system) is still startup. CPU load is shown as evidence.
- **"Periodic RDMA bursts" are not detected**, and network decides no label.
- **Stalled is narrower than "flat low power while RUNNING"**: it needs
  idle by utilization on every node, the stall time, compute before it, and
  CPUs that are idle too. Flat low power alone would
  call a job that never used its GPUs, an evaluation pause and CPU-only work
  a hang.
- **Disk IOPS are not used.** Throughput decides the write burst; IOPS add
  no separate condition.
- **Two labels that are not in the issue**: Unclassified and No GPU data.
- **Annotations**: a per-stretch draft through the label dialog instead of
  an overlay or a bulk export (decision 10).
- **Off by default.**

## Verification

- **Unit tests** of the algorithm with hand-built jobs for every rule and
  boundary (`segment.test.ts`).
- **Property tests** on 200 random jobs from a seeded generator
  (`segment.property.test.ts`): segments tile the window without gap or
  overlap; totals and shares add up; a bucket is "no data" exactly when no
  node has a GPU sample; a stall only where every GPU of every node is
  proven idle, after compute, in a run of the stall time; a checkpoint only
  with a known write rate at the burst level; no claim that needs a missing
  signal; no dependence on the unit of power, on the unit of the write rate
  (with a zero floor), on the network signal, on node order or start time;
  deterministic. The generator produces every label and every reason.
- **Accuracy on synthetic jobs** (`accuracy.test.ts`,
  `__fixtures__/syntheticJob.ts`). Jobs are generated as scraped samples
  (gauges read at scrape times, counters that integrate a rate, exporters
  out of phase, noise) and reduced to buckets like the queries do. Twenty
  jobs per row, each with three compute stretches, two checkpoints of two
  and three buckets, a startup and a stall:

  | Scrape, bucket | Buckets inside one phase, right | Boundary error mean / largest |
  |----------------|---------------------------------|-------------------------------|
  | 15 s, 1 min | 3007 of 3007 | 14 s / 39 s |
  | 30 s, 2 min | 3000 of 3000 | 33 s / 76 s |
  | 60 s, 4 min | 3000 of 3000 | 61 s / 138 s |

  Confusion at 15 s / 1 min, in minutes, rows are the phase that fills most
  of the bucket: startup 129 right, 2 unclassified; compute 2389 right,
  1 checkpoint, 10 unclassified; checkpoint 94 right, 1 compute,
  5 unclassified; stalled 482 right, 8 unclassified. All confusion is in
  buckets where two phases meet.

  Hard cases, each a test: no disk series (checkpoints become unclassified,
  never a phase); one stalled node of eight (job labels unchanged, node
  named); power-capped job (110 W working, 60 W idle); low GPU load (30%);
  a job shorter than ten samples (no result, no query); a 15-minute gap on
  every node (no data); a gap on one node of four during a stall (those
  buckets unclassified, the rest stalled); a gap on one node of two (no
  stall claimed); idle 4 minutes between steps (unclassified, no stall);
  25 minutes of CPU work with idle GPUs (unclassified); a hang three
  minutes after startup (found); GPUs never used (unclassified, not
  stalled); three days in 5-minute buckets.

  Share of the true checkpoint time reported, 1-minute buckets: 15 s 0%,
  30 s 30%, 45 s 85%, 60 s 81%, 90 s 91%, 2 min 91%, 5 min 96%.
- **Real backends.** The collection and segmentation code was run against
  Prometheus 3.5.0 and VictoriaMetrics 1.102.1 with generated telemetry of
  19 jobs (per-CPU node_exporter series, several disks, a loopback
  interface, a busy job before the job on the same nodes, a 64-node job, a
  3-day job). After the fixes of decisions 7 and 8, both backends gave the
  same label for every bucket as the fake backend of the tests, and no
  point was off the grid.
- **Real Grafana.** Grafana 13.3.1 with MariaDB and both backends, headless
  Chromium: the section in dark and light theme for 15 jobs, hover, zoom,
  the label draft (requests recorded), the settings page (save untouched,
  invalid value refused, edited values served by the backend), a cluster
  with the feature off.

Not verified: real telemetry from a production cluster; Grafana 12.4; the
Docker Compose E2E suite (`make test-integration` needs a Docker daemon);
the sidecar tests (not touched, and their dependency download is refused in
the build environment).

## Known weaknesses and open questions

- **Never run on real telemetry.** The thresholds (half of the working
  level, three times the write median, 90th percentile) are reasoned, not
  tuned. The synthetic jobs are cleaner than reality: phases switch at
  once, every GPU of a job behaves alike.
- **Shared nodes get no result** (decision 7). On clusters where small jobs
  share nodes this removes the feature for exactly those jobs.
- **Checkpoints to a network file system are invisible by default**
  (decision 8). The default write metric is local disks.
- **A long checkpoint without a write series reads as a stall** when the
  CPUs are idle during it, and CPU-only work below the CPU idle limit (one
  thread on a large node) reads as a stall too. A hang that spins on the
  CPUs is unclassified, not stalled.
- **A cluster without a CPU series gets no stall at all**: idle GPUs stay
  unclassified with the reason "too little CPU telemetry".
- **A hang that keeps GPU utilization above the idle threshold** is not
  idle. It is unclassified (GPUs low) while the job's working level comes
  from real compute, and it reads as compute when it fills more than nine
  tenths of the active buckets.
- **Suspension**: only "suspended now" is known. An earlier suspension reads
  as a stall. slurmdbd's suspend table is not read.
- **Mixed GPU models in one job** share one working level, and its power
  comes from the stronger model. When most nodes have the weaker model, no
  bucket has a majority of working nodes although every GPU is busy, and
  the job is unclassified. The reason text says what was measured ("in no
  bucket did more than half of the nodes reach the job's working level"),
  not "the GPUs never reached a working level". A level per node was
  considered and not taken: a node that spins at low power while the others
  work would then count as working.
- **The idle test covers the GPUs that report.** A GPU whose series is
  missing while its node's other GPUs report is not noticed. The GPU count
  is probed in up to three windows of ten minutes; GPUs of another job that
  report in none of them are not seen, and a job shorter than about 20
  minutes has one or two windows, so an exporter restart in it can still
  make the job look like one on shared nodes.
- **Aliasing.** Gauges are point samples. A load that repeats with a period
  near a multiple of the scrape interval is read at the same point of its
  cycle every time, so a GPU that is busy a third of the time can read as
  busy all the time.
- **CPU, storage and network are node-wide**: another job on the node can
  turn this job's GPU dip into a "checkpoint" or hide a stall.
- **Server-side work grows with the job** (decision 6). There is no cap on
  GPUs x duration other than the node limit.
- **The stall time counts across buckets in which a node did not report**,
  as long as more than half of the nodes reported and no reporting GPU was
  active. If a node works exactly while its exporter is silent, the buckets
  around it are labelled stalled although the stall was shorter.
- **Two settings name an idle threshold** once the efficiency scorecard
  (#147) is merged: `efficiency.idleGpuUtilizationPercent` and
  `phases.idleGpuUtilizationPercent`, and the two features have switches of
  opposite sense (`efficiency.disabled`, `phases.enabled`). They should be
  aligned when both are in.
- **Slowly alternating loads flicker.** A job that alternates between GPU
  work and waiting with a period near the bucket length gets many short
  unclassified stretches, because a bucket holds few samples per GPU.
- **An interactive job that waits for its user reads as stalled**, as does
  a `sleep` after the work. The label says "Stalled (GPUs idle)" for that
  reason.
- **Node names with regular-expression characters** (a dot in a fully
  qualified name) make every phase query fail with a parse error, and the
  section shows that error. The cause is the plugin's shared node matcher
  (`buildInstanceMatcher`), which escapes with a single backslash inside a
  double-quoted PromQL string; it affects the plugin's other queries in the
  same way and is not changed here.
- **The dev stack shows no phases.** The generated dev metrics oscillate
  without phases and carry one CPU series per node, which the section
  reports as not usable.
- **No E2E test in the repository** covers the section; the Playwright
  suite needs the Docker stack and dev data with phases.
- Should a running job's result refresh on its own? Today it does not.

## Merge with the efficiency scorecard (#147)

Both changes touch `settings.go`, `service.go`, `src/api/types.ts`, the
AppConfig files, `JobDashboardPage.tsx` and its test. The edits here are
single lines placed away from the lines #147 changes, and the settings
editor, the Go type and most tests are in files of their own. This change
does not depend on #147.

A test merge of this branch with `origin/agent/optimistic-gates-11g2pm` (at
`f006030`) has no conflict, and the merged tree passes the type check,
ESLint, all 1069 Jest tests, the Go tests and the complexity limits of
`cccc.toml`. Two things were needed for that beyond avoiding textual
conflicts:

- The tests of how the page wires the section live in
  `JobDashboardPage.test.tsx`, where each section of the page is a stub. A
  page test of its own rendered the scorecard for real after the merge and
  failed.
- The page function `JobDashboardPage` is kept at a cyclomatic complexity
  of 22 (23 on main, limit 26 in `cccc.toml`), so that the scorecard's
  branch still fits (23 in the merged tree).
