---
type: Agent Skill Reference
title: "OptimizeXP DX — developer tools"
description: "Local CLIs, doctor scripts, IDE shims, and agent-facing tooling ergonomics."
tags: [hobo, optimizexp, dx, dev-tools]
timestamp: 2026-07-30T00:00:00Z
---

# DX — dev tools

## Inventory

| Tool class | Examples |
|---|---|
| Doctor / bootstrap | `pnpm run doctor`, setup scripts |
| Search | `tgrep`, `rg`, `ast-grep` |
| Token hygiene | RTK, headroom, caveman |
| Semantic code | Serena MCP |
| Package scripts | consistent `test`/`lint` names |

## HoBo anchors

- `scripts/setup-agent-tools.sh` progressive layers
- `pnpm run search`, `pnpm run search:structure`
- `docs/agent-tooling.md` risk table
- Devcontainer common layer without key prompts

## Friction smells

- Must install global CLIs before first useful command
- Tools documented but not on PATH after setup
- Duplicate install paths per agent with divergent versions

## Uncertainty smells

- Optional tools fail open with cryptic errors
- `tgrep` missing silently falls back without saying so (document the fallback)

## Optimization moves

- Progressive setup: common → one agent shim
- `doctor` reports missing optional tools as advisories
- Same script entrypoints for humans and agents
