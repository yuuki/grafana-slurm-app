# Node Health

The Node Health page ranks compute nodes by how strongly they correlate with failed Slurm jobs. Use it to identify nodes that deserve further investigation before checking hardware logs or monitoring data.

Node Health is read-only. It does not drain nodes or make scheduler changes, and a high score does not by itself prove a hardware fault.

## Cluster and Time Range

Select the target Slurm cluster from the **Cluster** dropdown. Use the preset buttons or the time range picker to choose the period to analyze. The default range is the last 7 days.

The page includes finished `COMPLETED`, `FAILED`, and `NODE_FAIL` jobs whose end time falls within the selected range. Cancelled, timed-out, preempted, running, and pending jobs are not included.

## Node Ranking

Nodes are sorted by score, with the strongest failure signal first. The table shows the evidence behind each score:

| Column | Description |
|--------|-------------|
| Node | Slurm node name |
| Jobs | Number of included jobs that used the node |
| Failed | Number of included `FAILED` or `NODE_FAIL` jobs that used the node |
| NODE_FAIL | Number of `NODE_FAIL` jobs that used the node |
| failed_node hits | Number of jobs where Slurm attributed the failure directly to this node |
| Failure rate | Percentage of the node's included jobs that failed |
| Score | Relative strength of the failure signal |
| Last failure | End time of the most recent failed job involving the node |
| View jobs | Opens Job Search for the node and selected time range |

## How the Score Works

The score compares a node's failures with the number expected from the cluster-wide failure rate. A node scores higher when it appears in more failures than expected.

Multi-node jobs contribute less evidence to each individual node than single-node jobs. `NODE_FAIL` jobs add stronger evidence, and an exact `failed_node` match adds the strongest evidence. This keeps the score useful during a cluster-wide rise in failures while giving more weight to failures that Slurm attributes to a node.

Some Slurm database schemas do not include the `failed_node` column. In those environments, Node Health continues to calculate rankings without direct-attribution hits, so the `failed_node hits` value remains 0 and the rest of the failure evidence is still available.

Score badges use the following ranges:

- **Green**: score below 1
- **Orange**: score of 1 or higher but below 5
- **Red**: score of 5 or higher

The score is a ranking aid, not a diagnosis. Compare the listed jobs and operational data before taking a node out of service.

## Low Sample Rows

Rows based on fewer than 5 jobs are shown in gray. The small sample may produce an unstable score, so these rows always use a green score badge even when the numeric score is high. They remain in the table so that recent or lightly used nodes are not hidden.

## Truncated Results

Node Health analyzes at most the most recent 20,000 matching jobs. When more jobs exist in the selected range, the page displays a warning that the results are based on the most recent 20,000 jobs.

Shorten the time range if the analysis needs to cover every matching job in a busy cluster.

## View Jobs

Click **View jobs** to open [Job Search](./job-search.md) with the cluster, node name, and current absolute time range already applied. Use the job list and timeline to inspect the failures that contributed to the node's ranking.

## Hardware Metrics

The current Node Health score uses Slurm job history only. A future Phase 2 may add a node detail view with DCGM temperature, power, utilization, ECC, and Xid data when the configured exporters provide those metrics.
