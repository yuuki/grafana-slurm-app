# Job Search

The Job Search page is the main entry point for finding and browsing Slurm jobs. It provides filters, an interactive timeline, and a sortable job table.

![Job Search page with filters, timeline, and job table](./images/job-timeline.png)

## Cluster Selection

Select the target Slurm cluster from the **Cluster** dropdown at the top of the page. If your Grafana instance monitors multiple clusters, each cluster has its own jobs and metrics datasource.

## Filters

Use the filter bar to narrow down jobs:

| Filter | Description |
|--------|-------------|
| **Job ID** | Direct lookup by Slurm job ID. Bypasses other filters and jumps straight to the job dashboard. |
| **Job Name** | Search by job name with autocomplete suggestions |
| **User** | Filter by the submitting user (autocomplete) |
| **Account** | Filter by Slurm account (autocomplete) |
| **Partition** | Filter by Slurm partition (autocomplete) |
| **State** | Filter by job state: All, Running, Completed, Failed, Pending, Cancelled, Timeout |
| **Nodes (min / max)** | Filter by allocated node count. Specify a minimum, maximum, or both to define a range. |
| **Elapsed (min / max)** | Filter by wall-clock runtime. Enter hours and minutes (e.g., `1 h 30 m`). For running jobs the elapsed time is calculated up to now. Pending jobs (not yet started) are automatically excluded. |

Click the **Search** button to apply filters. Filter values are saved to your browser's local storage and restored on your next visit.

## Job Timeline

The timeline visualization shows jobs as horizontal bars on a time axis. Each bar represents a single job, color-coded by state:

- **Green**: Running
- **Blue**: Completed
- **Red**: Failed
- **Orange**: Pending / Suspended / Timeout
- **Gray**: Cancelled / Preempted

The timeline displays job ID, name, partition, user, and node count. Use the time range picker (default: last 6 hours) and the navigation arrows to pan across time.

Click any bar to open the job's dashboard.

## Job Table

Below the timeline, a table lists all matching jobs with the following columns:

| Column | Description |
|--------|-------------|
| Job ID | Slurm job identifier |
| Name | Job name |
| User | Submitting user |
| Account | Slurm account |
| Partition | Slurm partition |
| State | Color-coded state badge |
| Nodes | Number of allocated nodes |
| GPUs | Total GPU count (or `-` if none) |
| Start | Job start timestamp |
| Elapsed | Wall-clock duration |

Click any row to open the [Job Dashboard](./job-dashboard.md) for that job.

The table uses cursor-based pagination (100 jobs per page).

## Linked Dashboard Picker

When clicking a job, a picker may appear if external dashboards tagged with `slurm-job-link` exist in your Grafana instance. This lets you choose between:

- **Job view**: The built-in per-job dashboard
- **External dashboards**: Custom Grafana dashboards that accept Slurm job variables

The picker remembers your last selection per cluster.
