---
type: Agent Skill Reference
title: "OptimizeXP AX — agent harness CLIs"
description: "Host agent CLIs, setup script, doctor, agent:check, and session land (sdlc --finish)."
tags: [hobo, optimizexp, ax, cli, harness, doctor, agent-check]
timestamp: 2026-07-31T00:00:00Z
---

# AX — harness CLIs & local agent commands

How coding-agent **hosts** and **repo scripts** expose status and next actions without tribal knowledge.

## Host CLIs (matrix)

| Host | Typical CLI | Skills tree | MCP config | Notes |
|---|---|---|---|---|
| Claude Code | `claude` | `.claude/skills` | `.mcp.json` | Subagents under `.claude/agents/` |
| Cursor | Cursor agent / IDE | `.agents/skills` | `.cursor/mcp.json` | Rules under `.cursor/rules` |
| Codex | `codex` | `.agents/skills` | `~/.codex/config.toml` (from `.codex/config.toml`) | Global MCP paste/add |
| Grok Build | Grok TUI / tools | skill discovery | product MCP | workflows under optimizexp/grok |
| Copilot CLI | `copilot` | limited | — | Superpowers marketplace path |

Deep host wiring: [agents-config.md](agents-config.md).

## Repo commands agents must find

| Command | Purpose | AX bar |
|---|---|---|
| `bash scripts/setup-agent-tools.sh --help` | Progressive install flags; zero-key path | exit 0; names AUTH + `--no-gbrain` |
| `bash scripts/setup-agent-tools.sh --common-only --no-gbrain` | Default safe install | skip reinstall when tools present |
| `pnpm run doctor` | Node/pnpm **and** agent-tooling readiness | AUTH.md (WorkOS auth.md + residual keys)/MCP/setup/launchers; optional PATH warns |
| `pnpm run agent:check -- --staged` | Narrow staged gates | clear success footer; no full-repo default |
| `pnpm run skills:mirror-check` | Dual skill trees identical | exit 0 |
| `/sdlc` / `/sdlc --finish` | Full loop / session land | documented in AGENTS + skill |
| `pnpm run search` / `search:structure` | Discovery before tests | used instead of broad test sweeps |

## Friction smells

- `--help` is `unknown option` with no usage  
- Doctor green while MCP configs / AUTH missing  
- `agent:check` forces package/repo scope for one-line skill edits  
- Setup reinstall floods pip “already satisfied” on every re-run  
- Feature bindings wire **live** evals (`eval:agent:live`) for offline journeys  

## Uncertainty smells

- Host needs global config paste (Codex) but project template is silent  
- Multiple “setup” scripts with different flag names  
- Success with exit 0 but broken agent PATH (no warn)  

## Optimization moves

1. Usage() + AUTH pointers on setup; fail-closed MCP launchers.  
2. Doctor agent-tooling section (fail critical files; warn optional bins).  
3. Impact-scoped `agent:check`; success line.  
4. optimizexp discovery demotes live egress scripts for offline seeds.  
5. Document `/sdlc --finish` for commit→PR→merge-commit session land.

## Evidence

- CLI transcripts: setup --help, doctor, agent:check --staged  
- Feature folders: `agent-tooling-setup`, `cli-help-and-doctor`, `agent-check-staged`  
