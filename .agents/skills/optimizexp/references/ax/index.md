---
type: Agent Skill Reference
title: "OptimizeXP AX — section map"
description: "Progressive-disclosure map of agent-experience audit surfaces for optimizexp --ax runs."
tags: [hobo, optimizexp, ax, index]
timestamp: 2026-07-31T00:00:00Z
---

# AX — agent experience sections

When the run includes **`--ax`** (or all experiences), load **this index first**, then only the
section files that match the surfaces under review. Do **not** dump every AX file into context.

Score each surface for **harms**, **friction**, and **uncertainty** (0–5) with evidence. Prefer
offline probes (`pnpm run doctor`, setup `--help`, skill mirrors, local MCP launchers).

## Section map

| Section | File | Audit when… |
|---|---|---|
| **Specs & standing contracts** | [specs.md](specs.md) | AGENTS.md, **WorkOS AUTH.md/auth.md**, UI tokens, llms.txt, .env.example |
| **MCP** | [mcp.md](mcp.md) | Tool discovery, shared launchers, fail-closed missing binary/key |
| **Agent skills** | [agent-skills.md](agent-skills.md) | Skill trees, progressive disclosure, dual mirrors |
| **Harness CLIs** | [harness-clis.md](harness-clis.md) | Host CLIs, setup script, doctor, agent:check, sdlc --finish |
| **Model routing** | [model-routing.md](model-routing.md) | Which model/backend for which task; cost/latency/quality tradeoffs |
| **Token optimization** | [token-optimization.md](token-optimization.md) | caveman, headroom, RTK, progressive disclosure, context tax |
| **Instruction files** | [agents-md.md](agents-md.md) | Structure of AGENTS.md / CLAUDE.md / nested rules (detail for specs) |
| **Host agents & config** | [agents-config.md](agents-config.md) | Claude/Cursor/Codex/Grok/Copilot wiring, subagents |
| **Hooks & plugins** | [hooks-plugins.md](hooks-plugins.md) | SessionStart, RTK hooks, Superpowers, always-on rules |
| **Auth (WorkOS auth.md)** | [auth.md](auth.md) | Agent registration protocol + residual local tooling keys |

## Suggested load order for a full AX pass

1. [specs.md](specs.md) + [auth.md](auth.md) — standing contracts (incl. WorkOS auth.md)  
2. [harness-clis.md](harness-clis.md) — doctor, setup, agent:check, finish  
3. [mcp.md](mcp.md) + [agent-skills.md](agent-skills.md) — tools and skills  
4. [token-optimization.md](token-optimization.md) + [model-routing.md](model-routing.md)  
5. [agents-config.md](agents-config.md) + [hooks-plugins.md](hooks-plugins.md) + [agents-md.md](agents-md.md) as needed  

## HoBo product anchors (quick)

| Concern | Where |
|---|---|
| Agent registration auth (WorkOS) | `AUTH.md` / auth.md protocol — https://workos.com/auth-md |
| Local tooling keys residual | `AUTH.md` residual tables, `.env.example`, `docs/agent-tooling.md` |
| Agent table + rules | `AGENTS.md`, `CLAUDE.md` |
| Setup | `scripts/setup-agent-tools.sh --help` |
| Doctor (incl. agent-tooling) | `pnpm run doctor` |
| MCP launchers | `scripts/agent-mcp-{serena,headroom,gbrain}.sh` |
| Skill mirrors | `pnpm run skills:mirror-check` |
| Design tokens / UI | `site/src/styles/global.css`, `pnpm run design:lint` |
| Experience proofs (ax) | `src/draft/exp-proofs/ax/`, `_classification.md` |

## Metrics mapping (AX-specific)

| Smell class | Typical metric |
|---|---|
| Wrong live eval / egress default | **harms** + friction |
| Missing --help / fail-closed remediation | friction + uncertainty |
| Instruction contradictions / stale skill README | uncertainty |
| Always-on compression with no disable path | friction (+ harms if safety text mangled) |
| Model routing that forces expensive model for trivial gates | friction (cost) |
| AGENTS.md / skill wall-of-text with no progressive disclosure | friction (context tax) |

## Related

- Parent skill progressive disclosure: `../index.md`, `SKILL.md` experience branches  
- Product tooling narrative: `docs/agent-tooling.md`  
- Repo performance ladder: `AGENTS.md` + `repo` skill  
