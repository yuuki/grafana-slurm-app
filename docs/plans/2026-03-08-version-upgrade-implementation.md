# Version Upgrade Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Go、Grafana 関連依存、フロントエンド依存、CI、Docker、README のバージョン定義を最新の互換構成へ更新する

**Architecture:** Go 側は `go.mod` の direct dependency と toolchain を更新し、`go mod tidy` で間接依存を再解決する。フロントエンド側は Grafana 12.4 系と `@grafana/scenes` 7 系の peer dependency に合わせ、React 18 / `react-router-dom` 6 系を維持しつつ直接依存を最新へ更新する。

**Tech Stack:** Go modules, npm, Grafana plugin SDK, GitHub Actions, Docker Compose

---

### Task 1: 更新対象の確定

**Files:**
- Modify: `go.mod`
- Modify: `package.json`
- Modify: `.github/workflows/e2e.yml`
- Modify: `docker-compose.yaml`
- Modify: `src/plugin.json`
- Modify: `README.md`

**Step 1: Go と npm の更新候補を確認**

Run: `go list -m -u -mod=mod all`
Expected: 更新可能な Go module の一覧が表示される

**Step 2: npm の直接依存更新候補を確認**

Run: `npm outdated`
Expected: 直接依存の current / wanted / latest が表示される

**Step 3: peer dependency を確認**

Run: `npm view @grafana/scenes@7.1.2 peerDependencies`
Expected: React 18 / react-router-dom 6 系が必要であることが確認できる

### Task 2: Go 依存と toolchain の更新

**Files:**
- Modify: `go.mod`
- Modify: `go.sum`

**Step 1: direct dependency を更新**

Run: `go get github.com/go-sql-driver/mysql@latest github.com/grafana/grafana-plugin-sdk-go@latest`
Expected: `go.mod` の direct dependency が更新される

**Step 2: toolchain / indirect dependency を再解決**

Run: `go get -u -t ./... && go mod tidy`
Expected: 間接依存を含めて `go.mod` / `go.sum` が再計算される

### Task 3: npm 依存と周辺設定の更新

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/e2e.yml`
- Modify: `docker-compose.yaml`
- Modify: `src/plugin.json`
- Modify: `README.md`

**Step 1: 互換性を維持した直接依存バージョンへ更新**

Run: `npm install`
Expected: `package.json` / `package-lock.json` が更新される

**Step 2: CI / Docker / README のバージョン表記を同期**

Expected: Go、Node、Grafana の記述と実際の依存バージョンが一致する

### Task 4: 検証

**Files:**
- Test: `pkg/...`
- Test: `src/...`
- Test: `e2e/...`

**Step 1: Go テストを実行**

Run: `go test ./...`
Expected: PASS

**Step 2: フロントエンド検証を実行**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS
