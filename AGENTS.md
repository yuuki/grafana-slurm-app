# Repository Guidelines

## Project Structure & Module Organization
This repository is a Grafana plugin for monitoring Slurm jobs. The frontend lives under `src/`: API clients in `src/api/`, shared UI components in `src/components/`, page-level views in `src/pages/`, and Scenes-based view logic in `src/scenes/`. The Go backend is implemented under `pkg/plugin/`, with the entry point in `pkg/main.go`. End-to-end tests live in `e2e/tests/`, fixtures in `e2e/fixtures/`, and local development configuration in `dev/` plus `docker-compose*.yaml`.

## Build, Test, and Development Commands
- `npm run dev`: Run the frontend in Webpack watch mode.
- `npm run build`: Build production frontend assets into `dist/`.
- `mage -v build:linux`: Build the Go plugin backend binary for Grafana.
- `npm test`: Run Jest tests matching `src/**/*.test.{ts,tsx}`.
- `npm run typecheck`: Run the TypeScript type checker.
- `npm run lint`: Run ESLint on `src/`.
- `npm run server`: Start the local Docker Compose environment.
- `npm run e2e:setup && npm run e2e`: Start the E2E stack and run Playwright tests.

## Coding Style & Naming Conventions
Use 2-space indentation for TypeScript and TSX. For Go, follow standard `gofmt` formatting. Name React components in `PascalCase`, functions and variables in `camelCase`, and test files as `*.test.ts` or `*.test.tsx`. ESLint is used for linting, and `@swc/jest` is used for test transforms.

## Testing Guidelines
Unit and UI tests use Jest with Testing Library, and browser-level validation uses Playwright. Add new UI tests close to the related code under `src/`, and place flow or integration coverage under `e2e/tests/`. Before opening a PR, run at least `npm test`, `npm run typecheck`, and `go test ./pkg/... -v`.

## Commit & Pull Request Guidelines
The recent history mostly follows Conventional Commit prefixes such as `fix:`, `feat:`, `ci:`, and `chore:`. Keep commit subjects short and imperative. Pull requests should include a summary of the change, affected areas, verification commands run, screenshots for UI changes, and links to related issues.

## Security & Configuration Tips
Do not commit secrets. Keep Slurm database credentials and Grafana configuration in local or deployment-specific settings. For local development, prefer the provided `docker-compose.yaml`, and keep ports bound to localhost unless external access is explicitly required.
