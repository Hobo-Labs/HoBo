---
type: Agent Skill Reference
title: "OptimizeXP AX — AGENTS.md instruction files"
description: "Instruction files agents load at session start: structure, token cost, and conflict control."
tags: [hobo, optimizexp, ax, agents-md]
timestamp: 2026-07-31T00:00:00Z
---

# AX — AGENTS.md / CLAUDE.md

Part of the broader **specs** surface: [specs.md](specs.md).

## Role

`AGENTS.md` (and nested `CLAUDE.md` / folder `AGENTS.md`) is the **standing brief**. Every token
competes with task context.

## Optimization checklist

1. **Stable rules first**, narrative last.  
2. Point to skills/references instead of pasting full procedures.  
3. Nested `AGENTS.md` only for folder-specific law (e.g. `src/draft/**`).  
4. Caveman / always-on modes explicitly scoped and disable-documented.  
5. No secrets; keys only as env var **names** (AUTH.md for tables).  
6. Agent tooling table stays current with `docs/agent-tooling.md` and doctor.  

## HoBo anchors

- Root `AGENTS.md` — architecture rules, agent tooling table, performance ladder  
- `CLAUDE.md` — may compose `@` includes  
- Draft-layer `src/draft/**/AGENTS.md`  

## Friction / uncertainty smells

- Contradictions between root AGENTS and a skill  
- Instructions that force broad installs/tests  
- Stale tool lists vs `docs/agent-tooling.md`  
- Missing `/sdlc --finish` or doctor agent-tooling after those ships  

## Metrics mapping

- Long irrelevant sections → friction (context tax)  
- Contradictions → uncertainty  
- Unsafe “always send code to cloud X” → harms  

## Related

- [token-optimization.md](token-optimization.md)  
- [specs.md](specs.md)  
- [auth.md](auth.md)  
