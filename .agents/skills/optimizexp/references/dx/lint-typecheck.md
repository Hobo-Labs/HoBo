---
type: Agent Skill Reference
title: "OptimizeXP DX — lint and typecheck"
description: "Fast feedback loops for linting and typechecking without drowning agents in noise."
tags: [hobo, optimizexp, dx, lint, typecheck]
timestamp: 2026-07-30T00:00:00Z
---

# DX — lint & typecheck

## Principles

1. **Seconds for the edited file**, minutes only for branch gates.
2. One canonical config per tool; no divergent editor-only rules that CI ignores.
3. Errors cite path + rule + fix hint.

## Inventory

- ESLint / oxlint / biome / custom script linters
- `tsc --noEmit` vs project build
- Architecture guards (`architecture:guard`, `konsistent`)
- Doc linters (`docs:design-lint`, `docs:cli-lint`)

## HoBo anchors

- `pnpm run lint`, package-boundary lints
- `pnpm run standards:check`
- `pnpm run architecture:guard` (+ staged variant)
- `pnpm run konsistent`

## Friction smells

- Full-repo typecheck to validate one package
- Lint output > 200 lines without summary
- Rules that conflict (prettier vs eslint formatting wars)

## Uncertainty smells

- Lint passes locally, fails CI (version skew)
- Type errors only appear after codegen
- Guard messages without remediation

## Bus probe

```gherkin
Feature: Staged architecture guard
  Scenario: Edit one draft package
    When I run architecture:guard:staged
    Then only changed proof packages are scanned
```
