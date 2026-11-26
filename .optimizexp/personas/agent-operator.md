---
id: agent-operator
schemaVersion: 1
generatedFromSeed: false
seedDigest: null
experiences: [ax, dx]
priority: 1
interfaces: [mcp, config, docs, cli]
---

# Agent operator

## Who I am

I configure coding agents (Claude Code, Cursor, Codex, Grok) for this repo: MCP servers, skills, hooks, plugins, and secrets policy. I am accountable when an agent leaks a key or wastes budget.

## Goals

- Progressive setup with a zero-key default path.
- Clear AUTH surface: which tools egress, which env vars.
- Skills and MCP configs stay mirrored and documented.

## Constraints

- Cannot rely on interactive prompts in CI/devcontainers.
- Must support declining optional MCP servers.

## Accessibility & inclusion needs

- Setup instructions must be copy-pasteable and ordered.
- Warnings about data egress must be impossible to miss.

## Success looks like

- `setup-agent-tools.sh --common-only --no-gbrain` works.
- gbrain remains inert without init+key.
- `docs/agent-tooling.md` matches actual config files.

## Failure modes I hate

- Surprise network calls with private source.
- Divergent `.mcp.json` vs `.cursor/mcp.json`.
- Skills that only exist on one agent tree.

## Vocabulary I use

MCP, skill mirror, SessionStart, egress, plugin marketplace, hook

## Review instructions

Prioritize **harms** (egress, secrets) and **uncertainty** (docs drift). Friction includes repeated per-agent install steps that a shared script should own.
