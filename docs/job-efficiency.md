# Job Efficiency

The **Efficiency** section of the [Job Dashboard](./job-dashboard.md) compares what a job allocated (its `AllocTRES`) with what its telemetry shows over the job's run. It answers four questions:

| Finding | Question |
|---------|----------|
| Idle GPUs | Did the job use every GPU it allocated? |
| Idle GPU time | For how much of the allocated GPU time did the GPUs do nothing? |
| GPU memory headroom | How full did the GPU memory get? |
| CPU and I/O bottleneck | Did the GPUs wait for CPUs or for storage? |

Each finding shows the **evidence** it rests on. It shows **advice** only when the evidence supports it. The scorecard is read-only: it changes neither the job nor the scheduler.

![Efficiency section of a job that used four of its eight GPUs](./images/job-efficiency.png)

## Unknown is not zero

The scorecard follows one rule:

> A number or a sentence about idleness or a bottleneck is shown as a fact only when the telemetry provably belongs to the job and covers it. Otherwise the finding is **Inconclusive**, or says that there is no telemetry, and names what is missing.

Missing telemetry is never counted as idle or wasted, and telemetry that may belong to another job is never counted as the job's. Every finding has one of these states:

| State | Meaning |
|-------|---------|
| **Warning** | The evidence proves waste or a bottleneck. The finding has advice. |
| **OK** | The evidence rules it out. |
| **Inconclusive** | The telemetry can do neither. The finding says why: a node of the job does not report, the job shares its nodes, or the telemetry has gaps. |
| **No data** | The metric returned nothing for the job's nodes and time. |
| **Not applicable** | The finding does not apply, for example GPU memory when no GPU was active. |
| **Query failed** | The query for this finding failed. The other findings stay. |

A job is **not scored** at all, and no query is sent, when:

- the job's `AllocTRES` records no GPUs,
- the job has not started,
- the job ran for less than 5 minutes (with the usual 15 to 60 second scrape interval it holds too few samples per GPU, and most of its time is start-up),
- the job was suspended for a part of its run, or is suspended now (see [Suspended and runaway jobs](#suspended-and-runaway-jobs)),
- slurmdbd records the job as running more than one hour past its time limit,
- the cluster has no metrics datasource, or its efficiency settings are invalid,
- the job's nodes report more GPU series than the scorecard reads (see [Query cost](#query-cost)),
- job efficiency is turned off for the cluster (see [Turning it off](#turning-it-off)).

A **running** job is scored up to two minutes ago: the newest samples are still on their way to the metrics backend, and a bucket they have not reached would read as a gap. The section says so, and **Score again** repeats the scoring. A finished job is scored once per page load.

## What is scored

### The scored window and its buckets

The scorecard splits the job's run into equal **buckets**. Every bucket lies inside the job's run, so no bucket holds samples of the jobs that ran on the nodes before or after.

From ten buckets on, the bucket boundaries are multiples of the bucket length (full minutes for one-minute buckets). The parts of the job before the first and after the last boundary, each shorter than one bucket, are not scored; the section states how much. A job with fewer than ten buckets is split from its end backwards, so only its start can be left out.

- A bucket is at least 60 seconds long.
- A job has at most 240 buckets. A longer job gets longer buckets: a 3-day job has 240 buckets of 18 minutes.
- A job on many GPUs gets fewer buckets, see [Query cost](#query-cost).

### Which series belong to the job

The job's series are selected like the dashboard panels select them: by the job's node list and the cluster's Instance Label, Node Matcher Mode and optional Metrics Filter. Series of nodes that are not in the job's node list are ignored.

slurmdbd records how many GPUs a job holds, not which ones, and not how they are spread over the job's nodes. The exporters do not label series with the job. So the scorecard decides **per node** whether the GPUs that report can be the job's:

| GPUs reporting on the job's nodes | Meaning | Result |
|-----------------------------------|---------|--------|
| Every node reports, and together as many GPUs as the job allocated | The job holds every GPU of its nodes. | Exact numbers. |
| Every node reports, and together more GPUs than the job allocated | The job shares its nodes, or holds only some of their GPUs. The telemetry cannot tell which GPUs are the job's. | Lower bounds, marked with ≥, or **Inconclusive**. |
| A node of the job reports no GPU | The job's share of the nodes that do report depends on what it holds on the silent node. The reporting GPUs cannot be matched to the job. | Every finding is **Inconclusive** and names the nodes. The tiles read **Unknown**. |
| A node reports only some of its GPUs (its GPU IDs leave gaps) | The GPUs that do not report may be the job's, and the ones that do may be another job's. | Every finding is **Inconclusive** and names the node. The tiles read **Unknown**. |
| Every node reports, but together fewer GPUs than the job allocated | Some GPUs of the job have no telemetry, and the others cannot be matched to it. | Every finding is **Inconclusive**. The tiles read **Unknown**. |

Comparing only the total would be wrong. Example: a job holds 4 GPUs on each of two nodes. The first node has 8 GPUs and reports them all, 4 busy and 4 unused by anyone. The second node has no exporter. 8 GPUs report and 8 are allocated, but the 4 unused GPUs are not the job's.

The lower bound on shared nodes works as follows. If the nodes report 8 GPUs, the job allocated 6, and only 1 of the 8 was ever active, then at most 1 of the job's GPUs was active, so at least 5 never were. If 6 or more of the 8 were active, nothing can be shown either way.

This rests on one assumption: **an exporter reports every GPU of its node, or none**. The scorecard checks it where the telemetry allows: when the GPU IDs of a node are numbers and leave gaps (for example only `4, 5, 6, 7`, or `0, 1, 3`), some GPUs of that node do not report. The node then counts like a node without telemetry: every finding is **Inconclusive** and names the node. IDs numbered from 0 or from 1 without gaps pass the check. It cannot see a GPU that is missing at the end of the range, and it does not apply to IDs that are not numbers; see [Limitations](#limitations).

### Idle GPUs

A GPU is **active** in a bucket when at least one utilization sample of that bucket exceeds the **idle baseline**. The default baseline is 5% utilization.

```
active(gpu, bucket) = max_over_time(utilization[bucket]) > idle baseline
```

- An **idle GPU** is a GPU that was active in no bucket with telemetry, and has telemetry for at least 95% of the buckets. When an idle GPU misses a bucket, the finding says so: "never exceeded 5% utilization in any bucket with telemetry", with the number of buckets its telemetry covers (for example 119 of 120). Nothing is claimed about the buckets without telemetry, and the advice is limited to "in the buckets with telemetry".
- A GPU that was active in no bucket in which it reported, but has telemetry for less than 95% of the buckets, has **gaps in telemetry**. It is listed, and it is not counted as idle. The **Never-active GPUs** tile then shows a lower bound (`≥`), because such a GPU may never have been active either.
- When every GPU reported in every bucket, the finding also states the highest number of GPUs that were active in the same bucket.

Why 95% and not every bucket: one lost scrape is ordinary, and with one-minute buckets it empties a bucket. Demanding every bucket would withdraw the finding from most jobs of a few hours. 95% allows one bucket in twenty: one lost scrape per 20 minutes, or an exporter restart of 3 minutes per hour. It still refuses telemetry with real holes: a scrape interval longer than the buckets (every second bucket empty), a longer outage, or a job that is partly older than the metrics retention. A job with fewer than 20 buckets needs telemetry in every bucket.

**Warning** when at least one allocated GPU was idle. The advice names the number of GPUs the workload ran on. **OK** when every allocated GPU was active. **Inconclusive** when no GPU is known to be idle but some have gaps.

Why 5%: DCGM reports utilization as the share of time in which a kernel ran on the GPU. A GPU without work reports 0. A few percent come from context creation and monitoring, not from a workload. The test uses the highest sample of the bucket, so one sample above the baseline marks the whole bucket as active. This is lenient on purpose: idle time is never overstated.

Only utilization is used. The issue that proposed this feature also mentions power. Idle power differs by GPU model, so it has no baseline that holds for every cluster.

### Idle GPU time

Every bucket splits the allocated GPU time three ways. When the job holds every GPU of its nodes:

```
active        = GPUs active in the bucket      x bucket length
idle          = GPUs reporting but not active  x bucket length
no telemetry  = allocated GPUs not reporting   x bucket length
```

On shared nodes a bucket gives a bound only when **every GPU of every node of the job reports in it**:

```
active (at most)  = min(allocated, GPUs active in the bucket)  x bucket length
idle (at least)   = allocated GPUs x bucket length - active
```

In any other bucket the whole allocated time is "no telemetry". The GPUs that report there may be fewer than the job allocated and still not be the job's: the job's GPUs may be the ones on the node whose exporter is down.

- **Idle GPU-hours** is the sum of `idle` over all buckets.
- **GPU time in use** is `active / (active + idle)`. Time without telemetry is in neither part.

The finding compares the idle time with the whole allocated GPU time:

| | Condition |
|-|-----------|
| **Warning** | The proven idle time is at least 25% of the allocated GPU time. |
| **OK** | The job holds every GPU of its nodes, and the idle time plus the time without telemetry stays under 25%. |
| **Inconclusive** | Anything else: the time without telemetry could lift the idle time to 25%, or the value is a lower bound on shared nodes. |

A healthy batch job measures close to 0%, because a bucket with a single active sample counts as active. 25% leaves room for the start-up of a short job (5 minutes of staging in a 20-minute job).

### GPU memory headroom

For every GPU the scorecard reads the highest memory use and the lowest free memory of each bucket, and takes the extremes over the scored window:

```
capacity   = peak used + lowest free
peak share = peak used / capacity
```

At the moment of the peak the free memory is at its lowest, and the two add up to what the device offers. Memory that the driver reserves is not part of either metric, so the share is slightly overstated, never understated.

**Warning** when the fullest GPU stayed below the **low memory threshold** (default 15%) and the memory metrics cover every GPU in at least 95% of the buckets (the same rule as for idle GPUs; the finding states the number of buckets covered when it is not all of them). The advice is a GPU type with less memory, or a larger batch size. The default is the value the feature request names. It is conservative: it flags only jobs that would fit a device with a small fraction of the memory. The numbers are always shown, so you can judge the cases in between.

- If the memory telemetry misses a GPU, or more than 5% of the buckets of a GPU, a low value is **Inconclusive**: the peak may lie where the telemetry is missing.
- On shared nodes the fullest GPU may belong to another job. A low value still holds for the job, because the job's GPUs cannot be fuller than the fullest GPU of its nodes. A high value is **Inconclusive**.
- **Not applicable** when no GPU was active.

### CPU and I/O bottleneck

This finding looks for an input pipeline that cannot feed the GPUs. It compares the CPU load with the GPU utilization in **windows of 5 minutes**.

- Buckets up to 5 minutes long: the windows follow each other without a gap.
- Longer buckets: one window at the end of each bucket. The windows are then a sample of the job; the finding states the share of the scored window they cover.

No window may read the CPU time of the job that ran on the nodes before. Every window lies inside the scored window, and **no window begins sooner than 75 seconds after the job's start**. The reason for the 75 seconds is the way a rate is computed. A rate needs two samples. Prometheus takes both from inside the window. MetricsQL (VictoriaMetrics) also uses the last sample before the window, so its rate covers up to one scrape interval before the window as well. The scorecard does not know which rule the datasource follows, so it is built for the wider one:

- With a node exporter scraped every 60 seconds or faster, the sample before a window that begins 75 seconds into the job lies inside the job (60 seconds, plus room for a late scrape).
- For slower scrapes the lead a window needs follows from the samples it holds: a CPU series with n samples in 5 minutes is scraped less than 300 / (n - 1) seconds apart, and the window counts only when it begins at least that long after the job's start. With a scrape every 120 seconds, a window that begins less than 150 or 300 seconds into the job (3 or 2 samples) is left out.

A window that is left out for this reason is **unknown**, like a window with missing telemetry (see below). What this costs:

- A job shorter than 6 minutes 15 seconds has no window, and the finding is **Inconclusive**.
- Every job loses up to the first 75 seconds, and up to one window more when its windows end on full 5 minutes. A job of about 10 to 11 minutes keeps one window, which covers less than half of it, so the finding is **Inconclusive** (see the 12-window rule below).

This rests on regular scrapes: the bound on the scrape interval comes from the samples inside the window.

In a window:

```
GPU in use     = mean utilization of the GPU in the window > idle baseline
GPUs underused = mean utilization of the GPUs in use < 50%
CPUs saturated = busy CPUs      >= 90% of the job's CPUs
I/O wait high  = CPUs in iowait >= 10% of the job's CPUs
busy CPUs      = CPUs - idle CPUs - CPUs in iowait
```

A window **counts** when at least one GPU was in use and the telemetry is complete: every CPU of every node of the job and every GPU of the job report in it. A window in which a node, a CPU or a GPU does not report is **unknown**: it may or may not have been a bottleneck. A window with complete telemetry and no GPU in use is left out; a phase in which the job uses no GPU at all is idle GPU time, not a bottleneck.

| | Condition |
|-|-----------|
| **CPU-bound** (Warning) | Underused GPUs and saturated CPUs coincide in at least 25% of the windows that count and the unknown windows together. The windows that show it are enough on their own. Advice: more CPUs per GPU, more data-loader workers. |
| **I/O-bound** (Warning) | The same for underused GPUs and high I/O wait. Advice: faster or node-local storage. |
| **OK** | Neither reaches 25%, even if every unknown window showed it. The evidence still states how often the GPUs were underused and how many CPUs were busy then. Few busy CPUs next to underused GPUs point to a single-threaded data loader; the scorecard shows the numbers and leaves the conclusion to you. |
| **Inconclusive** | Anything else. The finding states both bounds. |

A verdict needs at least 12 windows, or windows that cover at least half of the scored window. Three samples of 5 minutes in a job of several days decide nothing.

The thresholds are fixed. 90% busy and 10% I/O wait are common alerting thresholds for hosts; 50% means that the GPUs waited for more than half of the time.

The CPU metrics are read per node, in CPUs: `rate(node_cpu_seconds_total[5m])`, summed per node. A third query counts the CPU series of a node and their samples in the window (`count_values` over `count_over_time`). The CPU count of a node is the most CPUs that had two samples or more in one window. The CPUs of the job's nodes are compared with the job's allocated CPUs (`cpu` in `AllocTRES`):

| The job holds | Result |
|---------------|--------|
| Every CPU of its nodes | The nodes' CPU load is the job's. A bottleneck can be reported. |
| Fewer CPUs | The nodes' load includes other jobs. If even the node-wide load stays under the job's levels, the finding is **OK**. Otherwise it is **Inconclusive**. |
| An unknown number (no `cpu` in `AllocTRES`), or more CPUs than its nodes report | **Inconclusive** |

More cases are **Inconclusive**:

- A node of the job has no CPU telemetry. The finding names the node.
- The job does not hold every GPU of its nodes, so GPU utilization cannot be attributed to it.
- The nodes export no `iowait` mode, so an I/O bottleneck cannot be ruled out (a CPU bottleneck is still reported).
- `node_cpu_seconds_total` does not add up to one second per second and CPU, so it is not node_exporter's per-CPU counter.

Slurm counts the CPUs it is configured with. If Slurm is configured with cores and the nodes run two threads per core, node_exporter reports twice as many CPUs, and the job counts as holding only some of them.

### Suspended and runaway jobs

Two kinds of job are not scored, because the time between their start and their end is not all theirs:

- **A job that was suspended.** A suspended job keeps its allocation but does not run, and its GPUs may run another job meanwhile. The plugin reads only the total time a job was suspended (`time_suspended` of the job table), not when it was suspended, so that time cannot be cut out of the telemetry. slurmdbd does record the start and end of every suspension, in `<cluster>_suspend_table`; the plugin does not read that table today. Reading it is the way to score such jobs later, with the suspended spans left out. The scorecard says for how long the job was suspended. While a job is suspended, slurmdbd holds no duration: the column holds a value derived from the time of the suspension, which the next resume turns into the total. The scorecard then says only that the job is or was suspended.
- **A job that slurmdbd records as running more than one hour past its time limit.** Its end is probably missing from the accounting database (a "runaway job", see `sacctmgr show runawayjobs`), and its nodes may run other jobs by now. The hour leaves room for the grace time a cluster may give (`OverTimeLimit`).

A runaway job that has no time limit, or is still within it, cannot be told from a running job. It is scored as running.

## Thresholds

| Threshold | Value | Configurable |
|-----------|-------|--------------|
| Idle baseline (GPU utilization) | 5% | Per cluster: Idle GPU Utilization (%) |
| Low GPU memory | below 15% of capacity | Per cluster: Low GPU Memory (%) |
| Idle GPU time warning | at least 25% of the allocated GPU time proven idle | No |
| Underused GPUs | GPUs in use average below 50% | No |
| CPUs saturated | at least 90% of the job's CPUs busy | No |
| I/O wait high | at least 10% of the job's CPUs in iowait | No |
| Bottleneck | coincides in at least 25% of the windows | No |
| Windows for a bottleneck verdict | at least 12, or half of the scored window covered | No |
| Lead of the first CPU window | at least 75 seconds after the job's start, more for scrapes slower than 60 seconds | No |
| Shortest job scored | 5 minutes | No |
| Telemetry for an idle GPU, and for low GPU memory | a sample in at least 95% of the buckets | No |
| Running past the time limit | more than 1 hour | No |

## Per-GPU evidence

**Per-GPU evidence** lists every GPU with its activity, highest and mean utilization, the share of its observed buckets in which it was active, and its peak memory. Idle GPUs come first.

When the job does not provably hold every GPU of its nodes, the list is titled **GPUs reporting on the job's nodes** and says that a row may describe another job's GPU. An idle GPU is then not marked as a warning.

## Requirements

- GPU metrics with one series per GPU, for every GPU of a node. The defaults are the names of the [NVIDIA DCGM exporter](https://github.com/NVIDIA/dcgm-exporter): `DCGM_FI_DEV_GPU_UTIL` (percent), `DCGM_FI_DEV_FB_USED` and `DCGM_FI_DEV_FB_FREE` (MiB), with the GPU in the `gpu` label. Other names and another GPU label can be set per cluster, see [Configuration](./configuration.md#efficiency-settings). The units must be the same: percent and MiB.
- For the CPU and I/O finding: [node_exporter](https://github.com/prometheus/node_exporter)'s `node_cpu_seconds_total` with one series per CPU and the modes `idle` and `iowait`, on every node of the job. This name is fixed. Without it the finding is **No data**; the GPU findings do not need it.
- A Prometheus or VictoriaMetrics datasource that keeps the job's time range. Parts of a job that are older than the retention are "no telemetry".
- A scrape interval of at most 60 seconds, so that every bucket holds a sample.

## Query cost

One scorecard sends 8 queries, one after another, through Grafana's datasource proxy. Every query aggregates in PromQL; none returns raw samples. When the page is left or another job is opened, the queries that were not sent yet are not sent.

| Queries | Kind | Response | One evaluation reads |
|---------|------|----------|----------------------|
| GPU utilization: bucket peak and bucket mean | 2 range queries | one point per GPU and bucket | the samples of one bucket |
| GPU memory: highest use and lowest free memory per bucket | 2 range queries | one point per GPU and bucket | the samples of one bucket |
| GPU utilization: mean per 5-minute window | 1 range query | one point per GPU and window | 5 minutes of samples |
| CPUs: idle, in iowait | 2 range queries | one point per node and window | 5 minutes of samples |
| CPUs: series per node by number of samples | 1 range query | one or two points per node and window | 5 minutes of samples |

- The buckets are sized so that GPUs x buckets stays at or under 24,000 points per response. The number of GPU series is not known before the first query. It is estimated as the allocated GPUs, or 8 GPUs per node if that is more. A job on 320 GPUs has 75 buckets; a job on 2,000 GPUs has 12.
- When the first response holds more GPU series than estimated (nodes with more than 8 GPUs), the buckets are sized again for the true number and the first query is sent once more, on longer buckets: 9 queries. Only that first response can exceed 24,000 points: with 16 GPUs per node it holds about twice as many.
- A job whose nodes report more than 24,000 GPU series is not scored.
- The CPU queries are not sent when their result could not change the finding (GPUs that cannot be attributed to the job, no active GPU). The GPU memory and CPU queries are not sent when the utilization metric has no data.
- A response that is not a complete Prometheus API result (an error page behind the proxy, a partial result with warnings) counts as a failed query, not as "no data".

The **Idle GPU-h** column of [Job Search](./job-search.md#idle-gpu-hours) adds 2 queries per loaded page of jobs.

## Turning it off

Job efficiency is on for every cluster. To turn it off for one cluster, open the plugin configuration, expand the cluster and its **Efficiency Settings**, and select **Turn off job efficiency for this cluster**. The Job Dashboard then shows no Efficiency section, Job Search shows no **Idle GPU-h** column, and none of the queries above is sent for that cluster.

Reasons to turn it off: the metrics backend should not take the additional queries, or the cluster's telemetry does not meet the [requirements](#requirements) or the assumptions listed under [Limitations](#limitations).

## Limitations

- The telemetry is per node and per GPU, not per job. Whether it belongs to the job is derived from counts, as described under [Which series belong to the job](#which-series-belong-to-the-job). On shared nodes the scorecard gives bounds or says **Inconclusive**.
- A node that reports only some of its GPUs for the whole job is detected only when its numeric GPU IDs leave gaps. A GPU that is missing at the end of the range leaves none. Example: a node has 8 GPUs with the IDs 0 to 7. A job holds 7 of them, among them GPU 7, which has failed and reports nothing. The 7 GPUs that report (IDs 0 to 6) leave no gap and are as many as the job allocated, so the scorecard takes them for the job's. If GPU 6 is not the job's and is unused, it is then reported as an idle GPU of the job, with the advice to request 6 GPUs. The same holds for IDs that are not numbers. The **Idle GPU-h** column of Job Search counts the GPUs of a node without their IDs and has no such check at all.
- GPUs that several jobs share at the same time (MPS, time slicing, `shard` GRES) are not told apart: activity and memory use of the other jobs on the same GPU count for the job.
- A node name that contains a dot (for example a fully qualified host name) breaks the query: the plugin's node matcher escapes the dot in a way that Prometheus rejects. The scorecard then shows the failed query, and Job Search shows `n/c`. The dashboard panels of such a job are affected in the same way.
- A runaway job without a time limit, or within it, is scored as a running job, on nodes that may run other jobs.
- Allocated memory and the time limit are not compared with usage.
- With buckets longer than 5 minutes (jobs longer than 20 hours, or jobs on many GPUs), the CPU and I/O finding samples the last 5 minutes of each bucket.
- The scorecard covers one job. To rank jobs, use the **Idle GPU-h** column of [Job Search](./job-search.md#idle-gpu-hours). It ranks the loaded jobs by a lower bound of their idle GPU-hours; there is no cluster-wide ranking over every job of a time range, and no sum per user or partition.
- The scored values depend on the scrape interval: a scrape interval longer than a bucket leaves buckets without data. With a scrape every 120 seconds and one-minute buckets (jobs up to 4 hours), every second bucket is empty: GPUs then have gaps in their telemetry and are not called idle, and only the idle GPU time finding can report the waste.
