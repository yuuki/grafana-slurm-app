# Annotation Labeling (TSFM)

Mark meaningful time windows on a job — thermal throttling, an NCCL stall, the
run-up to an abnormal exit — as tagged Grafana **region annotations**. These
labels are written org-level (not bound to any dashboard) so they outlive the
lens UI, and are collected downstream by the sakuraone `tsfm annotations
collect` pipeline (`GET /api/annotations?tags=tsfm:label`) into
`events.parquet` `source=human` records.

The feature is **off by default**. Enable it only where the core Grafana
annotation permissions of your users have been verified.

## Enabling the feature

In **plugin settings → Annotation Labeling (TSFM)**:

1. Turn on **Enable annotation labeling**.
2. Optionally edit the **Event types** vocabulary (comma-separated). Users can
   also enter custom event types at labeling time.
3. Choose the **Default quality** (`candidate` or `confirmed`).

Each cluster you want to label must also have a **TSFM Cluster ID** set (in its
Cluster Profile): the canonical id — e.g. `isk` or `osk` — written into the
`tsfm:cluster=` tag. It must be unique across clusters and is required when
labeling is enabled. Because Slurm job IDs repeat across clusters, the cluster
id is what disambiguates a job's labels.

## Creating a label

1. Open the **Job Dashboard** for a job and pin at least one metric so the
   Scene (and its time range) exists.
2. Zoom a panel until the window of interest fills the view — **zoom is the
   selection**. There is no separate drag-to-select layer.
3. Click **Label window** (next to *Export Dashboard*).
4. In the dialog:
   - **Time range** is pre-filled from the current view (stored as absolute
     time); fine-tune it if needed.
   - Pick or type an **Event type** (required).
   - Choose a **Quality** (`candidate` / `confirmed`).
   - Add an optional **Note**.
   - The **Tags preview** shows the exact tag array that will be written.
5. Click **Save label**.

A warning (non-blocking) appears if the selected window falls well outside the
job's execution period.

The saved annotation looks like:

```json
POST /api/annotations
{
  "time":    1751900000000,
  "timeEnd": 1751903600000,
  "tags":    ["tsfm:label", "tsfm:event=thermal_throttle", "tsfm:job=12345",
              "tsfm:cluster=isk", "tsfm:quality=candidate"],
  "text":    "GPU3 clock dropped from ~15:00; other GPUs nominal."
}
```

## Reviewing and confirming labels

The **Labels for this job** table lists every label for the current job (queried
by the three tags `tsfm:label` + `tsfm:job=<id>` + `tsfm:cluster=<cluster>`).
Each row shows the window, event type, quality, note, and author.

- Click a **window** to jump the Scene's time range to that label (review
  round-trip).
- Click **Confirm** to promote a `candidate` to `confirmed`. Confirm re-fetches
  the annotation first, replaces **only** the `tsfm:quality` tag, and preserves
  every other tag (including concurrent edits and unrelated tags). If the label
  drifted since it was listed — its identity tags changed, the marker was
  removed, or a duplicate quality tag appeared — the update is aborted and you
  are asked to reload.
- **Delete** (trash icon) removes a label after a confirmation dialog.

At most 100 labels are listed; a warning is shown if that limit is reached.

> **Concurrency:** the Grafana annotation API has no conditional update
> (ETag/revision). The GET-then-PATCH used by Confirm is therefore
> last-writer-wins. This is accepted by design; the re-fetch narrows, but does
> not eliminate, the race.

## Tag vocabulary (contract with tsfm)

| Tag | Meaning |
|-----|---------|
| `tsfm:label` | Required marker (the collector's query key) |
| `tsfm:event=<type>` | Event type. Default vocabulary: `thermal_throttle`, `nccl_stall`, `job_failure`, `perf_anomaly`, `network_degradation`, `other` |
| `tsfm:job=<id_job>` | Related Slurm job |
| `tsfm:cluster=<cluster>` | Canonical cluster id (`isk` \| `osk`) |
| `tsfm:quality=<q>` | `candidate` \| `confirmed` |

The contract between this app and tsfm is the tag **syntax** (`tsfm:key=value`),
not the event vocabulary — custom event types are allowed and are not validated
against the configured list, so vocabulary additions do not require a lock-step
release of both sides. The app does enforce syntax: non-empty (post-trim)
values, no duplicate `tsfm:event/job/cluster/quality` keys, and a 64-character
value limit.

The frozen JSON shape the app writes is captured in
`src/utils/__fixtures__/tsfm-annotation-contract.json` and asserted by a
generation test; the same file is mirrored into sakuraone
`tsfm/tests/fixtures/` for the collector's parser test. Changes must be made on
both sides together.

## Permissions

Creating, confirming (editing), and deleting labels use the browsing user's
session, so they are governed by core Grafana annotation permissions — no
service account is involved. A `403` surfaces an operation-specific message.
Verify the exact core RBAC action/scope for create / PATCH / delete in your
Grafana deployment before enabling the feature for a broad audience.
