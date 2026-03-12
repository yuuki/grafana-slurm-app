# MetricSifter Auto-Filter Design

## Overview

This document describes the design of the MetricSifter-powered auto-filter feature for the Job Dashboard `Metric Explorer`.

The goal is to help users reduce the visible metric set to metrics that show correlated change points during the selected job time range, without requiring Python support inside the Grafana plugin process.

## Goals

- Add a user-triggered auto-filter workflow to `Metric Explorer`.
- Keep the existing metric discovery and pinning workflow intact.
- Isolate the Python dependency in a dedicated service instead of embedding Python into the Go backend.
- Keep failure handling graceful so the dashboard remains usable when MetricSifter is unavailable.

## Non-Goals

- Automatic execution on every page load.
- Replacing manual metric search, prefix filtering, or pinning.
- Per-cluster MetricSifter service configuration in v1.

## Architecture

The implementation is split across three layers:

1. React frontend
   - Discovers candidate metrics as before.
   - Fetches `query_range` data from the configured metrics datasource through Grafana's datasource proxy.
   - Builds a dense time-series matrix payload from the returned series.
   - Calls the plugin backend to request MetricSifter-based filtering.
   - Applies the returned metric-key selection as an optional `Auto-filtered only` view.

2. Go plugin backend
   - Exposes `POST /api/metrics/auto-filter`.
   - Validates the payload and checks that `metricsifterServiceUrl` is configured.
   - Proxies the payload to the Python service.
   - Maps timeout and upstream failures to stable HTTP error responses for the frontend.

3. Python MetricSifter service
   - Accepts a normalized matrix payload.
   - Converts the payload into a `pandas.DataFrame`.
   - Runs `metricsifter.sifter.Sifter.run_with_selected_segment()`.
   - Returns selected metric keys and an optional selected window summary.

## Why a Separate Python Service

MetricSifter is implemented as a Python library and depends on the Python scientific stack. The Grafana app plugin backend is written in Go and runs inside Grafana's plugin process. Embedding Python into that environment would complicate packaging, deployment, and runtime assumptions.

Using a separate service gives clearer boundaries:

- Python dependencies remain isolated from the Go plugin.
- The Go backend stays small and focused on request validation and proxying.
- The service can be replaced, tuned, or scaled independently later.

## User Experience

The feature is intentionally manual in v1.

- Users open a job dashboard and wait for metric discovery to complete.
- Users click `Run auto filter` when they want a reduced metric set.
- On success, the UI shows a summary such as `Auto filter selected 8 of 42 metrics.`
- Users can enable `Auto-filtered only` to narrow the explorer to the selected metric subset.
- Search, prefix filtering, preview rendering, and pinning continue to work on top of the selected subset.

The result does not automatically pin metrics. Pinning remains an explicit user action.

## Data Flow

### 1. Candidate metric discovery

The existing discovery path remains unchanged:

- `discoverJobMetrics()` identifies raw metric candidates relevant to the job.
- The resulting `MetricExplorerEntry[]` becomes the candidate pool for auto-filtering.

### 2. Time-series collection

The frontend groups candidate metrics by matcher kind:

- `node`
- `gpu`

For each kind, it sends one `query_range` request using:

- a batched `__name__=~"...|..."` matcher
- the existing node / GPU instance matcher
- the optional cluster metrics filter label/value
- the current job dashboard time range

This avoids issuing one request per metric and keeps the query count bounded.

### 3. Matrix normalization

The frontend flattens each returned Prometheus matrix series into:

- `seriesId`
- `metricKey`
- `metricName`
- `values`

All timestamps are merged into one ordered timestamp array. Missing points are filled with `null` so the payload becomes a rectangular matrix.

### 4. Backend proxying

The frontend posts the normalized payload to:

- `POST /api/plugins/yuuki-slurm-app/resources/api/metrics/auto-filter`

The Go backend validates the request, forwards it to:

- `<metricsifterServiceUrl>/v1/filter`

and relays the selected metric keys back to the frontend.

### 5. MetricSifter execution

The Python service rebuilds the matrix as a `pandas.DataFrame`, where each column is one observed Prometheus label set.

The service then:

- runs `Sifter().run_with_selected_segment(dataframe)`
- collects surviving series IDs
- maps surviving series IDs back to metric keys
- returns deduplicated metric keys

If MetricSifter reports a selected segment, the service also maps the segment bounds back to request timestamps and returns a `selectedWindow`.

## Public Interfaces

### App configuration

`jsonData.metricsifterServiceUrl: string`
`jsonData.metricsifterDefaultParams?: MetricSifterParams`

- Optional in configuration.
- When unset, the auto-filter button remains visible but disabled.
- The backend validates that a non-empty value is an absolute `http` or `https` URL.
- MetricSifter defaults can be overridden from AppConfig.

### Runtime overrides

- Metric Explorer exposes an optional `Auto-filter settings` panel.
- Users can enable `Use custom settings` to override the app defaults for the current browser.
- Runtime overrides are persisted in browser local storage and applied to future runs until disabled or reset.

### Frontend to backend request

```json
{
  "clusterId": "a100",
  "jobId": "10001",
  "timestamps": [1700000000000, 1700000060000],
  "params": {
    "searchMethod": "pelt",
    "costModel": "l2",
    "penalty": "bic",
    "penaltyAdjust": 2.0,
    "bandwidth": 2.5,
    "segmentSelectionMethod": "weighted_max",
    "nJobs": 1,
    "withoutSimpleFilter": false
  },
  "series": [
    {
      "seriesId": "gpu:DCGM_FI_DEV_GPU_UTIL:gpu=0,instance=gpu-node001:9400",
      "metricKey": "raw:gpu:DCGM_FI_DEV_GPU_UTIL",
      "metricName": "DCGM_FI_DEV_GPU_UTIL",
      "values": [20, 40]
    }
  ]
}
```

### Backend to frontend response

```json
{
  "selectedMetricKeys": ["raw:gpu:DCGM_FI_DEV_GPU_UTIL"],
  "selectedSeriesCount": 1,
  "totalSeriesCount": 12,
  "selectedMetricCount": 1,
  "totalMetricCount": 8,
  "selectedWindow": {
    "fromMs": 1700000000000,
    "toMs": 1700000060000
  }
}
```

## Error Handling

The design favors graceful degradation.

- Missing service URL
  - Frontend keeps the feature disabled and shows a configuration hint.
  - Backend rejects direct requests with `400`.

- Invalid frontend payload
  - Backend returns `400`.

- Python service timeout
  - Backend returns `504`.

- Python service failure or malformed response
  - Backend returns `502`.

- Any frontend-side failure
  - The explorer remains usable with normal search and prefix filters.
  - The auto-filter area shows the error message.

## Testing Strategy

The implementation is tested at each boundary:

- Frontend unit tests
  - Matrix payload collection
  - UI summary and toggle behavior
  - Job dashboard auto-filter execution flow

- Go unit tests
  - Service URL validation
  - Default parameter parsing
  - Invalid request handling
  - Timeout behavior
  - Upstream error mapping
  - Invalid upstream JSON handling

- Python unit tests
  - DataFrame reconstruction
  - Mapping filtered series back to metric keys
  - Empty selection behavior
  - Parameter validation and constructor forwarding

## Future Enhancements

Potential follow-up work includes:

- adding a healthcheck and readiness gating for the MetricSifter service in Docker Compose
- surfacing `selectedWindow` more clearly in the UI
- adding request size limits inside the Python service
- adding a browser-level integration test against the local Grafana stack
