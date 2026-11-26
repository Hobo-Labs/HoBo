---
type: Agent Skill Reference
title: "OptimizeXP AX — token optimization"
description: "Context and output token reduction: progressive disclosure, caveman, headroom, RTK, skill size."
tags: [hobo, optimizexp, ax, tokens, headroom, rtk, caveman]
timestamp: 2026-07-31T00:00:00Z
---

# AX — token optimization

Token waste is friction (slow, expensive loops) and sometimes uncertainty (lost signal in noise).
Audit **input** (context fed to the model) and **output** (agent verbosity) separately.

## Layers (HoBo)

| Layer | Tool / pattern | What it compresses |
|---|---|---|
| Standing instructions | Progressive disclosure in skills (`references/`) | Skill body size |
| Standing brief | Thin AGENTS.md tables → deep docs | Always-on context |
| Context in | **headroom** MCP / proxy | Tool dumps, logs, files |
| Shell out | **RTK** command proxy + hooks | git/test/pnpm noise |
| Agent out | **caveman** (default on) | Prose fluff |
| Search | tgrep / rg / ast-grep before tests | Avoid huge test logs as discovery |
| Memory | gbrain (opt-in) | Long-term notes — **not** free; egress |

## Goals

- Default path works without cloud embedding  
- Disable paths documented for always-on compressors  
- Safety/clarity overrides (caveman Auto-Clarity) stay intact  

## Friction smells

- Skills paste entire procedures into SKILL.md instead of references/  
- `pnpm test` full suite as first tool call  
- MCP tools return multi-MB schemas every turn  
- Caveman on with no `/caveman` or stop instructions  

## Uncertainty smells

- Compressed shell output drops the only error line (RTK misconfig)  
- headroom compress without retrieve path documented  
- Contradictory “be brief” + “write a novel design doc” rules  

## Optimization moves

1. Skills: thin SKILL.md + branch load (see [agent-skills.md](agent-skills.md)).  
2. AX index progressive load (see [index.md](index.md)).  
3. headroom fail-closed launcher + local-first default ([mcp.md](mcp.md)).  
4. RTK hooks per agent; document `rtk gain`.  
5. Caveman disable: AGENTS block + `/caveman` / uninstall notes.  
6. agent:check impact scope; success footer without log walls.  

## Evidence

- Before/after token notes optional; prefer **behavioral** evidence: shorter transcripts, fewer tool rounds, same green gates  
- `pnpm run doctor` PATH lines for headroom/rtk  
- Skill mirror check after skill refactors  

## Related

- [model-routing.md](model-routing.md) — do not use a large model to fix token waste from bad discovery  
- [hooks-plugins.md](hooks-plugins.md) — SessionStart load cost  
