---
type: Agent Skill Reference
title: "OptimizeXP AX — MCP"
description: "MCP server wiring, shared fail-closed launchers, and agent ergonomics for tool use."
tags: [hobo, optimizexp, ax, mcp]
timestamp: 2026-07-31T00:00:00Z
---

# AX — MCP

## Goals

- Agents discover tools quickly across hosts  
- **Shared launchers** under `scripts/` (no per-host absolute paths)  
- Fail closed on missing binary/key with remediation — no bare “command not found”  
- Zero-key default; optional key tools opt-in with AUTH  

## HoBo anchors

| Config | Host |
|---|---|
| `.mcp.json` | Claude Code (auto-discovered) |
| `.cursor/mcp.json` | Cursor |
| `.codex/config.toml` | Codex template → `~/.codex/config.toml` or `codex mcp add` |

| Launcher | Server | Keys |
|---|---|---|
| `scripts/agent-mcp-serena.sh` | Serena (semantic code) | none |
| `scripts/agent-mcp-headroom.sh` | headroom (context compress) | none |
| `scripts/agent-mcp-gbrain.sh` | gbrain (memory) | embedding key + init; egress |

Probe: `pnpm run doctor` lists launchers; missing optional bins are **warn**.

## Friction smells

- Divergent MCP configs across the three hosts  
- Bare `gbrain serve` / `headroom mcp serve` without fail-closed wrapper  
- Tools require global installs not covered by `setup-agent-tools.sh`  
- Tool schemas huge and always loaded  

## Uncertainty / harms smells

- gbrain embeds private text without AUTH / in-session warning  
- Failed MCP connect hangs agent without remediation  
- Unstable tool names across versions  

## Optimization moves

1. Single launchers; wire all hosts + setup `mcp add` to the same scripts.  
2. Fail-closed: missing binary/key → exit 1 + setup/AUTH next steps.  
3. Document decline path for optional gbrain MCP.  
4. Exp proofs for MCP under `src/draft/exp-proofs/ax/` when shipping product MCP.  
5. Keep MCP `$comment` / codex header notes in sync when launchers change.  

## Evidence

- `bash scripts/agent-mcp-gbrain.sh` without key → remediation  
- Doctor lines for launchers  
- Diffs of `.mcp.json` / `.cursor/mcp.json` / `.codex/config.toml` parity  

## Related

- [auth.md](auth.md) — keys/egress for gbrain  
- [token-optimization.md](token-optimization.md) — headroom  
- [harness-clis.md](harness-clis.md) — setup install path  
