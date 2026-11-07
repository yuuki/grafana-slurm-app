@AGENTS.md

## Claude Code notes

- Skills: `.claude/skills/` holds relative symlinks to `.agents/skills/`, so
  `verify-grafana-ui` (UI checks against the Docker Compose stack) and
  `agent-browser` (the browser CLI it drives) load as Claude Code skills.
  Edit `verify-grafana-ui` in `.agents/skills/`; keep the symlinks relative
  and leave the vendored `agent-browser` files as `skills-lock.json` pins them.
