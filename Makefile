# Thin entry points shared with the maintainer's other repositories. The work
# itself stays in the existing task runners: npm scripts for the frontend,
# mage (Magefile.go, Grafana plugin SDK targets) for backend builds, the go
# tool for backend tests, and uv for the MetricSifter sidecar. See AGENTS.md.

# Tool versions. CI pins the same versions (.github/workflows); bump together.
GOLANGCI_LINT_VERSION   ?= v2.15.0
GOVULNCHECK_VERSION     ?= v1.9.0
ACTIONLINT_VERSION      ?= v1.7.12
ZIZMOR_VERSION          ?= 1.32.0
GH_ACTIONS_LOCK_VERSION ?= v0.4.1
OSV_SCANNER_VERSION     ?= v2.7.0
MAGE_VERSION            ?= v1.17.2
FUZZTIME                ?= 30s
FUZZFLAGS               ?=
BENCH_COUNT             ?= 6

# Not ./...: `npm ci` installs a Go package (flatted) under node_modules.
GO_PACKAGES := ./pkg/...

# `go run tool@version` would build each tool with that tool's own minimum Go
# version, and golangci-lint refuses to lint code newer than the Go it was
# built with. Build the tools with this module's toolchain (go env GOVERSION
# inside the module resolves to the go.mod go/toolchain line).
GO_TOOLCHAIN = $(shell go env GOVERSION)
GO_RUN = GOTOOLCHAIN=$(GO_TOOLCHAIN) go run

GOLANGCI_LINT ?= $(GO_RUN) github.com/golangci/golangci-lint/v2/cmd/golangci-lint@$(GOLANGCI_LINT_VERSION)
# uvx or pipx (preinstalled on GitHub-hosted runners) runs the pinned zizmor.
ZIZMOR ?= $(if $(shell command -v uvx 2>/dev/null),uvx zizmor@$(ZIZMOR_VERSION),pipx run zizmor==$(ZIZMOR_VERSION))
# gh-actions-lock (the `gh actions-lock` extension) runs through `go run` too.
GH_ACTIONS_LOCK ?= $(GO_RUN) github.com/github/gh-actions-lock/cmd/gh-actions-lock@$(GH_ACTIONS_LOCK_VERSION)
MAGE ?= $(GO_RUN) github.com/magefile/mage@$(MAGE_VERSION)

SIDECAR_DIR := dev/metricsifter_service
# The sidecar tests run on the Python version of the image that ships it.
SIDECAR_PYTHON ?= $(shell sed -n 's/^FROM python:\([0-9.]*\).*/\1/p' $(SIDECAR_DIR)/Dockerfile)

NODE_MODULES := node_modules/.package-lock.json

# pipefail keeps `go test ... | tee` from hiding a failing run.
SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c

.PHONY: help check build build-frontend build-backend lint lint-go lint-frontend fmt lint-actions lock-actions \
	test test-go test-race test-frontend test-sidecar test-integration test-fuzz test-lean bench vuln vuln-deps vuln-deps-sarif complexity

help: ## Show this help
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  %-15s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

check: lint lint-actions test-race test-frontend test-sidecar ## Local pre-PR gate (the required PR CI minus E2E)

build: build-frontend build-backend ## Build the plugin into dist/ (frontend bundle and linux/amd64 backend)

build-frontend: $(NODE_MODULES) ## Production frontend bundle (webpack)
	npm run build

build-backend: ## Backend binary for linux/amd64 (mage build:linux)
	$(MAGE) -v build:linux

lint: lint-go lint-frontend ## All linters: Go and frontend

lint-go: ## golangci-lint and go.mod tidiness
	$(GOLANGCI_LINT) run $(GO_PACKAGES)
	go mod tidy -diff

lint-frontend: $(NODE_MODULES) ## TypeScript type check and ESLint
	npm run typecheck
	npm run lint

fmt: ## Format Go code (frontend: npm run lint:fix)
	$(GOLANGCI_LINT) fmt

# zizmor's online audits need GH_TOKEN; without one (or with GH_TOKEN= on the
# command line) it runs offline.
# gh-actions-lock checks that .github/workflows/actions.lock pins every
# action the workflows use; with GH_TOKEN it also verifies each pin upstream.
lint-actions: ## Lint (actionlint) and audit (zizmor) the GitHub Actions workflows, and check their lockfile
	$(GO_RUN) github.com/rhysd/actionlint/cmd/actionlint@$(ACTIONLINT_VERSION)
	$(if $(GH_TOKEN),$(ZIZMOR) .,env -u GH_TOKEN $(ZIZMOR) --offline .)
	$(GH_ACTIONS_LOCK) $(if $(GH_TOKEN),--verify,--verify-local)

# Pin the actions in .github/workflows/actions.lock after a `uses:` changed,
# then review the diff. Needs a GitHub token (GH_TOKEN or `gh auth login`).
lock-actions: ## Update .github/workflows/actions.lock after changing a uses: line
	$(GH_ACTIONS_LOCK)

test: test-go test-frontend test-sidecar ## All unit tests: Go, frontend and sidecar

test-go: ## Go unit tests
	go test $(GO_PACKAGES)

test-race: ## Go unit tests with the race detector
	go test -race -cover $(GO_PACKAGES)

test-frontend: $(NODE_MODULES) ## Frontend unit tests (Jest)
	npm run test:ci

test-sidecar: ## MetricSifter sidecar tests (pytest via uv)
	cd $(SIDECAR_DIR) && PYTHONDONTWRITEBYTECODE=1 uv run --no-project --python $(SIDECAR_PYTHON) \
		--with-requirements requirements.txt python -m pytest -q -p no:cacheprovider tests

test-integration: ## Playwright E2E against the Docker Compose stack (e2e/run.sh; needs Docker and Playwright's chromium)
	bash e2e/run.sh

test-fuzz: ## Run every Go fuzz target for FUZZTIME (FUZZFLAGS=-parallel=2 on shared machines)
	@for pkg in $$(go list $(GO_PACKAGES)); do \
		targets=$$(go test -list '^Fuzz' $$pkg); \
		for f in $$(printf '%s\n' "$$targets" | awk '/^Fuzz/'); do \
			echo "== $$pkg $$f"; \
			go test -run='^$$' -fuzz="^$$f\$$" -fuzztime=$(FUZZTIME) $(FUZZFLAGS) $$pkg; \
		done; \
	done

test-lean: ## Lean proofs of the node budget arithmetic in spec/lean (needs elan on PATH)
	cd spec/lean && lake build

bench: ## Go benchmarks (compare runs with benchstat)
	go test -run='^$$' -bench=. -benchmem -count=$(BENCH_COUNT) $(GO_PACKAGES) | tee bench.txt

vuln: ## Known vulnerabilities reachable from the Go code
	$(GO_RUN) golang.org/x/vuln/cmd/govulncheck@$(GOVULNCHECK_VERSION) $(GO_PACKAGES)

OSV_SCANNER = $(GO_RUN) github.com/google/osv-scanner/v2/cmd/osv-scanner@$(OSV_SCANNER_VERSION) scan source \
	--lockfile=package-lock.json --lockfile=requirements.txt:$(SIDECAR_DIR)/requirements.txt

vuln-deps: ## Known vulnerabilities in the npm lockfile and the sidecar requirements (osv-scanner)
	$(OSV_SCANNER)

# CI uploads this SARIF file to code scanning, which tracks known findings as
# alerts and flags only the ones a pull request introduces. osv-scanner exits
# 1 when it finds vulnerabilities, but `go run` reports every failure as status
# 1, so a scan (or tool build) that failed is recognised by the missing report.
vuln-deps-sarif: ## osv-scanner results as SARIF in osv-scanner.sarif (fails only on scanner errors)
	@rm -f osv-scanner.sarif; status=0; \
		$(OSV_SCANNER) --format=sarif --output-file=osv-scanner.sarif || status=$$?; \
		if [ $$status -ne 0 ] && [ $$status -ne 1 ]; then exit $$status; fi; \
		test -s osv-scanner.sarif || { echo 'vuln-deps-sarif: osv-scanner wrote no report' >&2; exit 1; }

complexity: ## Cognitive / cyclomatic complexity ranking (needs cccc; thresholds in cccc.toml)
	cccc --table src pkg $(SIDECAR_DIR)

$(NODE_MODULES): package-lock.json
	npm ci
