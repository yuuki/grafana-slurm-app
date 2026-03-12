# Metric Explorer Aggregation Design

## Summary

This document describes the design of the Metric Explorer aggregation feature in the Slurm job dashboard.

The feature reduces rendering cost for high-cardinality GPU metrics by allowing the dashboard to show either:

- Aggregated GPU series grouped by node
- Raw per-device GPU series

The default dashboard mode is aggregated. Users can switch between aggregated and raw views without leaving the page. "Open in Explore" always uses the raw query so that detailed inspection remains available.

The design also includes the metric discovery behavior required to make the feature robust across heterogeneous label conventions and VictoriaMetrics-backed datasources.

## Goals

- Reduce the number of rendered GPU time series in Metric Explorer previews and pinned panels.
- Support different node-identifying labels such as `host.name` and `instance`.
- Keep the raw view available for debugging and detailed analysis.
- Keep the query behavior stable for both Prometheus-like and VictoriaMetrics-like datasources.
- Avoid duplicate explorer cards when the same metric is discovered through overlapping node and GPU matchers.

## Non-Goals

- Semantic optimization of each GPU metric beyond a uniform node-level `avg` aggregation.
- Cardinality reduction for non-GPU metrics.
- Persistence of the raw/aggregated display mode across sessions.
- Full arbitrary metric discovery for every datasource dialect if the datasource rejects selector-only discovery queries.

## User Experience

### Display Mode

Metric Explorer exposes two display modes:

- `Aggregated`
- `Raw`

The page default is `Aggregated`. The selected mode is shared by:

- Metric Explorer preview cards
- Pinned panels above the explorer

The mode is page-local state and is not stored in local storage.

### Aggregation Scope

Aggregation is applied only to GPU metrics. Node metrics continue to use raw queries.

If a GPU metric cannot be safely aggregated because no configured node label is present in the discovered label set, the dashboard falls back to the raw query for that metric.

## Configuration

Cluster configuration adds `aggregationNodeLabels: string[]`.

This is an ordered list of candidate labels used to identify a node for aggregation. Typical values are:

```json
["host.name", "instance"]
```

Default behavior:

- If `aggregationNodeLabels` is unset, initialize it as `["host.name", instanceLabel]`
- Remove duplicates

Relevant cluster fields:

- `metricsDatasourceUid`
- `metricsType`
- `instanceLabel`
- `nodeExporterPort`
- `dcgmExporterPort`
- `nodeMatcherMode`
- `metricsFilterLabel`
- `metricsFilterValue`
- `aggregationNodeLabels`

## Query Model

### Raw Dashboard Query

Raw dashboard queries use the metric as-is:

```promql
<metric>{<matcher>}
```

### Aggregated Dashboard Query

Aggregated GPU dashboard queries use:

```promql
avg by(<aggregationLabel>) (<metric>{<matcher>})
```

Legend behavior:

- Aggregated mode: `{{<aggregationLabel>}}`
- Raw mode: existing metric legend format

### Explore Query

Explore queries always stay raw:

```promql
<metric>{<matcher>}
```

This avoids hiding device-level detail in Explore.

## Datasource-Specific Label Syntax

The implementation formats label names differently depending on `metricsType`.

### Prometheus

Use quoted UTF-8 label syntax for non-legacy labels:

```promql
"host.name"="node001"
avg by("host.name") (...)
```

### VictoriaMetrics

Use bare dotted labels:

```promql
host.name="node001"
avg by(host.name) (...)
```

This distinction applies to:

- matcher construction
- filter labels
- aggregation labels
- exported dashboard queries

## Metric Discovery

### Why Discovery Is Special

Metric discovery exists to determine:

- which metrics exist for the current job
- which labels are available for legend formatting
- whether a GPU metric is eligible for node-level aggregation

The final dashboard query should cover the full job allocation. Discovery does not need to.

### Discovery Matcher Strategy

Discovery intentionally uses a single representative node rather than a regex covering every allocated node.

For the first node in `job.nodes`, discovery builds an exact matcher:

- `hostname` mode: `label="node001"`
- `host:port` mode: `label="node001:9400"`

This design was chosen because:

- discovery only needs representative label metadata
- exact selectors are more robust than large regex selectors
- some datasources reject the broader regex-based discovery selector

### Discovery Fallback

The preferred discovery path uses `/api/v1/series`.

If the datasource returns HTTP 422, discovery falls back to `/api/v1/query` and probes several query shapes in order:

1. `count_by_selector`
2. `count_by_last_over_time`
3. `last_over_time`
4. `group_by_last_over_time`

The first successful probe result is used.

If all probes fail, the UI surfaces a generic discovery error and a single debug log is emitted with enough context for investigation.

## Entry Construction and Deduplication

Discovered metrics are normalized by `metricName`, not by `(matcherKind, metricName)`.

This is required because node and GPU discovery matchers can overlap, especially when:

- `instanceLabel` is a host-level label such as `host.name`
- `nodeMatcherMode` is `hostname`

Without deduplication, the same GPU metric can appear twice:

- once as a node metric
- once as a GPU metric

That creates duplicate explorer cards, and only one of them may be aggregation-eligible.

### Kind Resolution Rules

If the same metric is seen through multiple discovery paths, the final kind is resolved in this order:

1. Known presentation kind from the curated metric catalog
2. GPU classification when the metric name starts with `DCGM_`
3. GPU classification when the discovered labels include `gpu`
4. Otherwise node

This ensures that overlapping DCGM metrics are represented only once and are treated as GPU metrics.

## Sorting

Dashboard result frames are sorted by legend using natural ordering so that values such as `node2` and `node10` are shown in a stable human-friendly order.

## Error Handling and Logging

The implementation intentionally keeps successful paths quiet.

Logs are emitted only for terminal failures:

- `Series discovery failed`
- `All fallback discovery probes failed`

The error log includes:

- cluster and job identifiers
- datasource type
- discovery node
- exact discovery queries
- fallback probe attempts and failures

Intermediate per-probe warning logs are intentionally not emitted to avoid noisy consoles during normal use.

## Testing Strategy

The implementation is covered by unit tests for:

- aggregation label resolution
- datasource-specific label formatting
- aggregated query generation
- discovery fallback behavior
- representative-node exact-match discovery
- deduplication of overlapping node/GPU discovery results
- page-level aggregation mode behavior
- legend sorting

Recommended verification commands:

```bash
npm test -- --runTestsByPath \
  src/pages/JobDashboard/scenes/metricDiscovery.test.ts \
  src/pages/JobDashboard/scenes/metricPanelsScene.test.ts \
  src/pages/JobDashboard/JobDashboardPage.test.tsx

npm run typecheck
go test ./pkg/... -v
```

## Trade-Offs

### Why Use One Representative Node for Discovery

Pros:

- simpler queries
- better compatibility with strict datasource parsers
- enough information for aggregation eligibility and preview construction

Cons:

- discovery assumes metric shape is consistent across nodes in the allocation
- highly heterogeneous jobs could hide node-specific custom metrics

This trade-off is acceptable because the main purpose of Metric Explorer is dashboard preview and pinning, not exhaustive schema inventory for every node.

## Future Work

- Add an optional explicit "discovery strictness" mode if exhaustive per-node discovery becomes necessary.
- Extend the curated GPU metric catalog if more device metrics should receive first-class titles and units.
- Consider a dedicated datasource capability flag if future Prometheus-compatible backends differ further in selector syntax.
