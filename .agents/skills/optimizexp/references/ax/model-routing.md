---
type: Agent Skill Reference
title: "OptimizeXP AX — model routing"
description: "Routing tasks to appropriate models/backends for cost, latency, quality, and safety."
tags: [hobo, optimizexp, ax, model-routing, cost]
timestamp: 2026-07-31T00:00:00Z
---

# AX — model routing

**Model routing** is which model/backend handles which class of work. Bad routing is an agent
experience defect: slow loops, surprise cost, or weak models on hard design tasks.

## Goals

- Cheap, fast models (or **no** model) for mechanical gates, format, search  
- Stronger models for design, adversarial review, hard diagnosis  
- Explicit opt-in for cloud backends that send code/prompts off-box  

## HoBo anchors

| Path | Routing note |
|---|---|
| Local gates (`agent:check`, doctor, biome, tsc) | Prefer deterministic CLIs — **zero** model |
| `improve` plans | May use a capable model; output is markdown plans only |
| SkillOpt | Offline trainer; default sleep backend **mock** (no-spend); live backends opt-in |
| gbrain | Embedding provider when enabled — cost + egress (AUTH.md) |
| Cloud coding agents (sdlc dispatch) | Isolated issues; same one-shot contract as local implementers |
| Superpowers / brainstorming | Session skills; no required paid API for superpowers itself |

## Friction smells

- Running full monorepo `pnpm test` as first agent step “to understand the repo”  
- Using a frontier model to reformat files a linter owns  
- No documented “use mock / local” path for SkillOpt or evals  
- Dispatch always picks the most expensive cloud agent for one-line docs  

## Uncertainty smells

- Unclear which model a host will use for a subagent  
- “eval:agent:live” as default feature binding (implies production spend)  
- Missing cost/egress note next to model choice  

## Harms smells

- Routing private code to a provider without consent or AUTH framing  
- Training/eval loops that exfiltrate secrets in prompts  

## Optimization moves

1. Performance-first ladder in AGENTS.md: search → narrow test → never broad discovery tests.  
2. optimizexp discovery **never** primary-binds live egress scripts unless seed opts into live.  
3. sdlc backend matrix: cloud for isolated issues; local worktrees for shared-file work.  
4. Document model/backend in issue contracts when cost-sensitive.  
5. Prefer deterministic harnesses (cucumber with mocks, vitest) over live LLM evals in default PR lanes.

## Score guidance

| Observation | Metrics |
|---|---|
| Default path requires live paid model | friction ≥ 3, uncertainty ≥ 2 |
| Secret or private corpus auto-sent to embedder | harms ≥ 3 |
| Clear local/mock path + expensive path labeled | friction ≤ 1 |

## Related

- [token-optimization.md](token-optimization.md) — reduce tokens after routing  
- [auth.md](auth.md) — egress when a cloud model is chosen  
- [harness-clis.md](harness-clis.md) — deterministic commands that need no model  
