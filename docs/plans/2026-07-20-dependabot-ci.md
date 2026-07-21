# Dependabot CI Failure Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make all currently failing Dependabot pull requests pass the repository's GitHub Actions checks without accepting unsupported dependency combinations.

**Architecture:** Keep runtime dependency versions within the peer-dependency ranges declared by Grafana Scenes and typescript-eslint. Align both CI workflows with the Go toolchain required by `go.mod`, and migrate the ESLint flat config to the ESM export used by `@grafana/eslint-config` v10.

**Tech Stack:** GitHub Actions, npm/package-lock, ESLint flat config, Go 1.26.4.

---

### Task 1: Align the Go toolchain used by CI — completed

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/e2e.yml`

**Step 1:** Change both `actions/setup-go` inputs from `1.26.1` to `1.26.4`, matching `go.mod`.

**Step 2:** Run `go vet ./pkg/...` and `go test ./pkg/... -v`.

### Task 2: Keep router and TypeScript updates within supported peer ranges — completed

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

**Step 1:** Use `react-router-dom@^6.30.4`, because `@grafana/scenes@6.57.2` requires `^6.28.0`.

**Step 2:** Use `typescript@^6.0.3` and the compatible `@typescript-eslint` resolution, avoiding TypeScript 7 while typescript-eslint 8 declares `<6.1.0` support.

**Step 3:** Run `npm ci`, `npm run typecheck`, `npm run lint`, and `npm run test:ci`.

### Task 3: Migrate the ESLint configuration to `@grafana/eslint-config` v10 — completed

**Files:**
- Delete: `eslint.config.js`
- Create: `eslint.config.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Step 1:** Replace `@stylistic/eslint-plugin-ts` with `@stylistic/eslint-plugin`.

**Step 2:** Import the default ESM export from `@grafana/eslint-config` and export the project config from `eslint.config.mjs`.

**Step 3:** Run `npm ci` and `npm run lint`.

### Task 4: Reflect validated changes in Dependabot branches — completed

**Step 1:** Update PR #61 with the supported router v6 lockfile.

**Step 2:** Update PR #60 with TypeScript 6.0.3 and the Go workflow fix.

**Step 3:** Update PR #59 with the ESM ESLint config migration.

**Step 4:** Update PR #56 with the Go workflow fix.

**Step 5:** Reflect the Go workflow fix in #61 and #59 as well, because both branches were based on the older workflow revision.

**Step 6:** Re-check all Dependabot PR checks. PR #58 was not green: frontend lint failed on `react-hooks/set-state-in-effect`, while backend and E2E were affected by the stale Go 1.26.1 workflow. The same ESLint rule suppression and Go 1.26.4 workflow update were reflected in #58; Dependabot's rebase temporarily removed the PR head ref, so GitHub Actions must run again after the rebase settles.

### Verification notes

- `npm ci --ignore-scripts` passed.
- `npm run typecheck`, `npm run lint`, and `npm run test:ci` passed; Jest reported 27 suites and 228 tests passing.
- `go vet ./pkg/...` and `go test ./pkg/... -v` passed.
- TypeScript 6 requires explicit `types` entries and the DOM `IntersectionObserver.scrollMargin` member used by the test mock; both are included in the project config.
