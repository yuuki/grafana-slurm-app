# Contributing

Thanks for helping improve the Slurm Job Monitor plugin.

- **Bugs and ideas**: open an issue describing what you expected and what
  happened (plugin and Grafana versions help). Security issues go through
  [SECURITY.md](SECURITY.md) instead.
- **Changes**: open a pull request against `main`. Keep it focused on one
  topic, and include tests for behaviour changes.

## Before you open a pull request

```bash
npm ci
make check
```

`make check` runs the same checks as the required pull request CI: Go and
frontend linters, the GitHub Actions audit, Go tests with the race detector,
Jest and the MetricSifter sidecar tests. It needs Node.js 26, Go (version in
`go.mod`) and [uv](https://docs.astral.sh/uv/). Run `make help` for the other
targets (E2E, fuzzing, benchmarks, vulnerability scans); [AGENTS.md](AGENTS.md)
explains when each one is needed and lists the compatibility contracts
(API routes, settings keys, plugin ID) that must not change silently.

Do not edit `.config/`: it is managed by Grafana's plugin tools.

## Commit messages

Commits, branches and pull request titles follow the Git conventions in
[AGENTS.md](AGENTS.md#git-conventions).
