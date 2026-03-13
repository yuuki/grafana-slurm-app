# Unified Raw Metric Flow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove internal `gpu/node` metric classification and make metric discovery, selection, and rendering flow operate on a single raw metric path that does not depend on fixed exporter ports.

**Architecture:** Replace the dual matcher/discovery pipeline with a single matcher per job/cluster, keyed only by metric name and labels. Simplify frontend metric keys from `raw:<kind>:<metricName>` to `raw:<metricName>`, remove curated GPU/node presentation logic, and keep legend generation generic based on discovered labels. Backend/API cleanup should remove exporter-port fields that are no longer required for runtime query generation.

**Tech Stack:** TypeScript, React, Grafana Scenes, Jest, Go, Go tests

---

### Task 1: Simplify Metric Keying And Discovery Model

**Files:**
- Modify: `src/pages/JobDashboard/scenes/metricDiscovery.ts`
- Modify: `src/pages/JobDashboard/scenes/model.ts`
- Test: `src/pages/JobDashboard/scenes/metricDiscovery.test.ts`
- Test: `src/pages/JobDashboard/scenes/model.test.ts`

**Step 1: Write the failing tests**

Add tests that assert:
- discovered metrics produce keys shaped as `raw:<metricName>`
- discovery executes a single matcher path instead of separate node/gpu paths
- generic legends are derived only from labels (`gpu`, `device`, fallback `instance`)

**Step 2: Run test to verify it fails**

Run: `npm test -- --runTestsByPath src/pages/JobDashboard/scenes/metricDiscovery.test.ts src/pages/JobDashboard/scenes/model.test.ts`

Expected: FAIL because discovery still expects `matcherKind`, dual queries, and `raw:gpu:` / `raw:node:` keys.

**Step 3: Write minimal implementation**

Implement:
- remove `MetricMatcherKind`
- change `buildRawMetricKey()` / `parseMetricKey()` to only use metric name
- collapse node/gpu discovery into one matcher builder
- replace curated presentation lookup with label-based generic legend generation

**Step 4: Run test to verify it passes**

Run: `npm test -- --runTestsByPath src/pages/JobDashboard/scenes/metricDiscovery.test.ts src/pages/JobDashboard/scenes/model.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/pages/JobDashboard/scenes/metricDiscovery.ts src/pages/JobDashboard/scenes/model.ts src/pages/JobDashboard/scenes/metricDiscovery.test.ts src/pages/JobDashboard/scenes/model.test.ts
git commit -m "refactor: unify raw metric discovery flow"
```

### Task 2: Update Panel Rendering And Auto Filter To Use One Matcher

**Files:**
- Modify: `src/pages/JobDashboard/scenes/metricPanelsScene.ts`
- Modify: `src/pages/JobDashboard/scenes/metricAutoFilter.ts`
- Modify: `src/pages/JobDashboard/JobDashboardPage.tsx`
- Test: `src/pages/JobDashboard/scenes/metricPanelsScene.test.ts`
- Test: `src/pages/JobDashboard/scenes/metricAutoFilter.test.ts`
- Test: `src/pages/JobDashboard/JobDashboardPage.test.tsx`

**Step 1: Write the failing tests**

Add tests that assert:
- raw metric panels use a single matcher shape without node/gpu branching
- auto-filter builds one instance matcher regardless of former metric kind
- saved selected metric keys no longer contain `gpu` / `node`

**Step 2: Run test to verify it fails**

Run: `npm test -- --runTestsByPath src/pages/JobDashboard/scenes/metricPanelsScene.test.ts src/pages/JobDashboard/scenes/metricAutoFilter.test.ts src/pages/JobDashboard/JobDashboardPage.test.tsx`

Expected: FAIL because the current implementation still branches on `matcherKind` and expects legacy keys.

**Step 3: Write minimal implementation**

Implement:
- single cluster/job matcher construction for raw metric queries
- update scene/query builders to stop reading `entry.matcherKind`
- update page state and local-storage handling to use simplified keys

**Step 4: Run test to verify it passes**

Run: `npm test -- --runTestsByPath src/pages/JobDashboard/scenes/metricPanelsScene.test.ts src/pages/JobDashboard/scenes/metricAutoFilter.test.ts src/pages/JobDashboard/JobDashboardPage.test.tsx`

Expected: PASS

**Step 5: Commit**

```bash
git add src/pages/JobDashboard/scenes/metricPanelsScene.ts src/pages/JobDashboard/scenes/metricAutoFilter.ts src/pages/JobDashboard/JobDashboardPage.tsx src/pages/JobDashboard/scenes/metricPanelsScene.test.ts src/pages/JobDashboard/scenes/metricAutoFilter.test.ts src/pages/JobDashboard/JobDashboardPage.test.tsx
git commit -m "refactor: remove matcher kind branching from raw metrics"
```

### Task 3: Remove Exporter Port Dependencies From API And Backend

**Files:**
- Modify: `src/api/types.ts`
- Modify: `pkg/plugin/service.go`
- Modify: `pkg/plugin/settings/settings.go`
- Modify: `pkg/plugin/export.go`
- Test: `pkg/plugin/settings/settings_test.go`
- Test: `pkg/plugin/export_test.go`

**Step 1: Write the failing tests**

Add tests that assert:
- cluster summaries no longer expose exporter-port fields
- settings parsing no longer requires or defaults exporter ports
- dashboard export uses the unified matcher strategy rather than fixed node/gpu ports

**Step 2: Run test to verify it fails**

Run: `go test ./pkg/plugin/... -v`

Expected: FAIL because service payloads, settings defaults, and export queries still include exporter ports.

**Step 3: Write minimal implementation**

Implement:
- remove exporter ports from cluster summary/API types
- delete defaulting and legacy migration for exporter ports
- update export query construction to use the same unified matcher semantics as the frontend

**Step 4: Run test to verify it passes**

Run: `go test ./pkg/plugin/... -v`

Expected: PASS

**Step 5: Commit**

```bash
git add src/api/types.ts pkg/plugin/service.go pkg/plugin/settings/settings.go pkg/plugin/export.go pkg/plugin/settings/settings_test.go pkg/plugin/export_test.go
git commit -m "refactor: drop exporter port runtime dependency"
```

### Task 4: Clean Up Docs And Run Final Verification

**Files:**
- Modify: `docs/configuration.md`
- Modify: `docs/metric-explorer.md`
- Modify: `src/components/AppConfig/types.ts`
- Test: `src/components/AppConfig/AppConfig.test.tsx`

**Step 1: Write the failing tests**

Add or update tests that assert:
- AppConfig still omits deprecated exporter-port settings
- any remaining docs/examples no longer reference gpu/node metric keys or exporter-port-based flows where removed

**Step 2: Run test to verify it fails**

Run: `npm test -- --runTestsByPath src/components/AppConfig/AppConfig.test.tsx`

Expected: PASS or no new failure if existing behavior already covers AppConfig. If docs have no automated checks, treat this step as a manual diff review before code edits.

**Step 3: Write minimal implementation**

Implement:
- update user-facing docs to describe the single raw metric flow
- remove stale type declarations or comments tied to exporter ports / matcher kind

**Step 4: Run test to verify it passes**

Run:
- `npm test -- --runTestsByPath src/components/AppConfig/AppConfig.test.tsx`
- `npm run typecheck`
- `npm run lint`

Expected: PASS

**Step 5: Commit**

```bash
git add docs/configuration.md docs/metric-explorer.md src/components/AppConfig/types.ts src/components/AppConfig/AppConfig.test.tsx
git commit -m "docs: describe unified raw metric flow"
```
