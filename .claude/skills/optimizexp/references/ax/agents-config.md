---
type: Agent Skill Reference
title: "OptimizeXP AX — host agents and config"
description: "Configuring coding agents, subagents, and host-specific CLIs consistently."
tags: [hobo, optimizexp, ax, agents, cli, subagents]
timestamp: 2026-07-31T00:00:00Z
---

# AX — host agents & config

## Host matrix (HoBo)

| Host | Skills tree | MCP config | Plugins | Subagents |
|---|---|---|---|---|
| Claude Code | `.claude/skills` | `.mcp.json` | `.claude/settings.json` | `.claude/agents/` |
| Cursor | `.agents/skills` | `.cursor/mcp.json` | rules | — |
| Codex | `.agents/skills` | `~/.codex/config.toml` | marketplace (machine) | — |
| Grok Build | skill discovery + workflows | MCP via product | workflows | subagent tool |
| Copilot CLI | limited | — | marketplace | — |

CLI ergonomics and repo scripts: [harness-clis.md](harness-clis.md).  
MCP detail: [mcp.md](mcp.md).

## Subagents (Claude Code backend for sdlc)

| Agent | Role |
|---|---|
| `implementer` | Implement assigned behavior, update dependencies, and verify the result |
| `reviewer` | Review the implementation and independently verify relevant checks |

Report changes and evidence in the response or pull request; do not create planning or status files.

## CLI ergonomics to score

- Help text discoverable (`--help`, consistent verbs)  
- Non-zero exit on failure; machine-readable modes when claimed  
- Auth errors distinguish “not logged in” vs “forbidden”  
- Setup script documents exact install commands per host  
- Codex global paste documented; project `.codex/config.toml` is the template  

## Friction smells

- Per-machine plugin install with no script path  
- Agent-specific features undocumented for other hosts  
- Subagent prompts omit hard rules (secrets, no shared files, staged agent:check)  
- Opening the repo auto-starts keyful MCP without decline guidance  

## Optimization moves

1. Shared setup: `scripts/setup-agent-tools.sh --agent <name> --no-gbrain`  
2. Shared MCP launchers referenced from every host config  
3. Document resume/reconcile (sdlc dispatch)  
4. Superpowers: note skills load at **session start**  
5. Keep host matrix in AGENTS + this file aligned  

## Related

- [hooks-plugins.md](hooks-plugins.md)  
- [model-routing.md](model-routing.md) — cloud vs local implementers  
