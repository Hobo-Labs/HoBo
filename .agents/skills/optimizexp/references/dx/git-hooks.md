---
type: Agent Skill Reference
title: "OptimizeXP DX — git tools and hooks"
description: "Githooks, git extensions, and staged checks that protect the main branch without blocking flow."
tags: [hobo, optimizexp, dx, git, hooks]
timestamp: 2026-07-30T00:00:00Z
---

# DX — git tools & hooks

## Inventory

| Mechanism | Role |
|---|---|
| `.githooks/` + `prepare-hooks` | Local pre-commit |
| Staged relevant checks | Fast path before commit |
| Generated-file guards | Block hand edits without sources |
| PR checks | Branch confidence |
| Agent git guardrails | Block destructive commands |

## HoBo anchors

- `.githooks/pre-commit` → `check:relevant:staged` / `agent:check -- --staged`
- `pnpm run prepare-hooks`
- `scripts/no-hand-edited-generated-files.mts`
- Skills: `git-guardrails-claude-code`, `repo` git-pr reference

## Friction smells

- Hooks run full CI locally
- Hooks missing after clone (no prepare step)
- Hooks fail without fix-forward message

## Uncertainty smells

- Bypass flags used casually (`--no-verify`) without audit
- Different hooks for different agents
- Hook selects checks that don't match CI

## Optimization moves

1. Staged + impact-scoped by default.
2. Print selected gates before running.
3. Document how to install hooks in setup skill.
4. Keep destructive git blocks in agent hooks, not human surprise.
