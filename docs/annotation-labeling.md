# Annotation Labeling

Mark meaningful time windows on a job as tagged Grafana **region annotations**.
Labels are written at the organization level, rather than being bound to a
dashboard, so they remain available across dashboard views.

The feature is **off by default**. Enable it only after verifying the core
Grafana annotation permissions granted to your users.

## Enabling the feature

In **plugin settings → Annotation Labeling**:

1. Turn on **Enable annotation labeling**.
2. Optionally enter comma-separated **Categories**. The default list is empty,
   and users can always enter a custom category while creating a label.

No additional cluster setting is required. The label's cluster tag uses the
existing **Cluster Profile ID** (for example, `gpu-a`). Because Slurm job IDs
can repeat across clusters, the profile ID disambiguates each job's labels.

## Creating a label

1. Open the **Job Dashboard** for a job and pin at least one metric so the
   Scene and its time range exist.
2. Zoom a panel until the window of interest fills the view. The current view
   is the selection; there is no separate drag-to-select layer.
3. Click **Label window** next to *Export Dashboard*.
4. In the dialog:
   - **Time range** is pre-filled from the current view and stored as absolute
     time. Fine-tune it if needed.
   - Pick or type a **Category** (required).
   - Add an optional **Note**. A non-empty note is trimmed and stored as the
     annotation text. If the note is empty or whitespace-only, the category is
     stored as the annotation text instead.
   - The **Tags preview** shows the exact tag array that will be written.
5. Click **Save label**.

A non-blocking warning appears if the selected window falls well outside the
job's execution period.

The saved org-level region annotation looks like:

```json
POST /api/annotations
{
  "time": 1767225600000,
  "timeEnd": 1767229200000,
  "tags": [
    "slurm-app:annotation",
    "slurm-app:schema=1",
    "slurm-app:job=12345",
    "slurm-app:cluster=gpu-a",
    "slurm-app:category=maintenance"
  ],
  "text": "Scheduled maintenance"
}
```

## Listing, jumping to, and deleting labels

The **Labels for this job** table lists labels matching all four scope tags:
`slurm-app:annotation`, `slurm-app:schema=1`, `slurm-app:job=<id>`, and
`slurm-app:cluster=<cluster-profile-id>`. Each row shows the window, category,
note, and author.

- Click a **window** to jump the Scene's time range to that label.
- **Delete** opens a confirmation dialog. After confirmation, the app
  re-fetches the annotation through `GET /api/annotations/:id`, verifies its
  marker, schema, job, cluster, and category identity, and rejects duplicate
  application-managed tags. It sends the delete request only if that preflight
  validation succeeds.

If the preflight request returns `404`, the label has already been removed; the
app reloads the list without sending a delete request. If the identity changed
or controlled tags are duplicated, deletion is aborted and the list is
reloaded. At most 100 labels are listed, and a warning appears when that limit
is reached.

> **Concurrency:** the preflight detects changes or duplicates present before
> the GET only in the managed identity tags: marker, schema, job, cluster, and
> category. It does not compare `time`, `timeEnd`, `text`, or unrelated tags,
> so changes to those fields are not detected. The Grafana annotation API has
> no conditional delete using an ETag or revision, and a label can still change
> or disappear between the GET and DELETE requests.

A `403` during preflight identifies missing annotation read access. A `403`
during deletion identifies missing annotation delete access. Other failures
show the backend error or an operation-specific fallback when no detail is
available.

## Tag schema

The app writes a fixed, versioned tag schema:

| Tag | Meaning |
|-----|---------|
| `slurm-app:annotation` | Required marker for annotations owned by this app |
| `slurm-app:schema=1` | Annotation schema version |
| `slurm-app:job=<job-id>` | Related Slurm job ID |
| `slurm-app:cluster=<cluster-profile-id>` | Existing Cluster Profile ID |
| `slurm-app:category=<category>` | Required configured or custom category |

External integrations should treat this schema as their input and convert it
to any consumer-specific model in a consumer-side adapter. The app schema
remains independent of those integrations.

## Permissions

Reading, creating, and deleting labels use the browsing user's session, so
core Grafana annotation permissions apply; no service account is involved.
Verify the exact core RBAC action and scope for read, create, and delete in your
Grafana deployment before enabling the feature for a broad audience.
