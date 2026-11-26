---
type: Agent Skill Reference
title: "OptimizeXP DX — build systems"
description: "Patterns for monorepo builds, incremental graphs, and developer-facing build feedback."
tags: [hobo, optimizexp, dx, build]
timestamp: 2026-07-30T00:00:00Z
---

# DX — build systems

## Goals

- Change one package → rebuild/test only what is needed
- Fail fast with actionable paths
- Agents and humans share the same entry commands

## Inventory

| Area | Probe |
|---|---|
| Package manager | `pnpm-workspace.yaml`, lockfile policy |
| Task runner | `turbo.json`, filter syntax |
| TypeScript project refs | root + package `tsconfig` |
| Codegen | `pnpm run codegen`, generated-file guards |
| CI parity | `.github/workflows` vs local `agent:check` |

## HoBo anchors

- `pnpm exec turbo run test --filter ./path`
- `scripts/relevant-check-policy.ts` — impact-scoped gates
- `pnpm agent:check` — staged / latest commit / PR base modes
- Performance-first ladder in `AGENTS.md`

## Friction smells

- Root `test` as default diagnostic
- Install as first reaction to any error
- Generated files hand-edited (guard should catch)
- No package-local `test` script

## Uncertainty smells

- Turbo "no output files" warnings treated as failures
- Different commands documented in README vs AGENTS.md
- Windows path / CRLF only discovered in CI

## Optimization moves

1. Document the **narrowest** command per change class.
2. Prefer filters and staged gates over full graphs.
3. Keep codegen as an explicit step with drift checks.
4. Align CI job names with local script names.
