@AGENTS.md

## Claude Code notes

- `.claude/skills/` holds relative symlinks to `.agents/skills/`: edit
  `verify-grafana-ui` in `.agents/skills/`, keep the symlinks relative, and
  leave the vendored `agent-browser` as `skills-lock.json` pins it.
