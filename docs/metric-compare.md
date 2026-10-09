# Metric Compare

Metric Compare draws one time series per job for a single metric, so you can compare runs side by side or scan many jobs quickly for the one that behaves differently.

## Opening the page

- **Navigation**: select **Metric Compare** in the plugin menu.
- **Job Search**: tick jobs in the table and click **Compare metric (n)** to compare exactly those jobs. With nothing ticked, the button opens Metric Compare with your current search filter.
- **Job Dashboard**: in Metric Explorer, click the **Compare across jobs** icon button on a metric card. Metric Compare opens with that metric, jobs with the same user and job name from the last 30 days, and the current job as the baseline.

## Choosing what to compare

- **Metric**: pick a metric from the list. Common GPU training metrics appear under **Suggested**. Counter metrics are shown as `rate(...[5m])`.
- **Jobs**: by default the page uses a search filter (the same filters as Job Search) over the last 7 days. Click **Edit filter** to change it. Up to 48 jobs are compared; when more jobs match, the newest 48 are shown and the page asks you to narrow the filter.
- Jobs without GPUs are hidden when the metric is a GPU (DCGM) metric.
- **Baseline**: click the anchor icon on a cell to overlay that job as a dashed line in every cell.

## View options

| Option | Choices | Notes |
|--------|---------|-------|
| Layout | Grid, Overlay | Overlay draws up to 10 jobs on one chart. Shift-click (or Cmd/Ctrl-click) cells in grid view to choose them. |
| X axis | Elapsed, Progress, Absolute | Elapsed aligns job start times. Progress maps each job from 0% to 100% so jobs of different lengths line up. Absolute uses wall-clock time. |
| Elapsed range | Whole job, First 1h / 6h / 24h | Elapsed axis only. |
| Reduce | Mean + min/max band, Mean, Max, Min | How each job's nodes and GPUs collapse into one line. |
| Y | Shared, Independent | Shared keeps heights comparable across cells. |
| Sort | Deviation from median, Mean (high to low), Mean (low to high), Start time, Duration, Job ID | |
| Columns | Auto, 2, 3, 4, 6 | Grid only. |

Hovering a cell shows a cursor at the same position in every cell. Click a cell to open a per-GPU view of that job; the dialog links to the full job dashboard.

## Deviation from median

When sorting by deviation, each job is resampled onto 200 points along the current x axis (elapsed time is used when the axis is Absolute). The page builds a median profile across jobs, scores each job by its average absolute distance from that profile, and outlines jobs whose score exceeds the median score plus two median absolute deviations. Running jobs are left out on the Progress axis because their progress is not final.

## Limitations

- On clusters where several jobs share a node, a job's series can include other jobs' activity on that node.
- The page state is kept in the URL, so you can share a link to the exact view.
