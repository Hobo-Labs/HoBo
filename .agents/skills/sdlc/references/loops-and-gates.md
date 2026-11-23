---
type: Agent Skill Reference
title: "SDLC loops and gates"
description: "Red/green inner loop and narrow-then-wide outer loop with required perf/contract/feature lanes."
tags: [hobo, sdlc, tdd, gates]
timestamp: 2026-07-02T00:00:00Z
---

# Loops & gates

## Inner loop (one package, minutes)

Strict red/green (compose with the `tdd` skill / Superpowers test-driven-development):

1. **Red:** write the failing test FIRST. The issue's acceptance checklist IS the test list —
   unit (`test/`), contract (PACT fixtures + consumer tests), feature (cucumber `features/` for
   epic behavior — ATDD: acceptance criteria become the failing scenario), bench (perf-critical
   paths; must execute).
2. **Green:** the smallest change that passes. Prefer compile-time feedback: typecheck,
   generated-contract, CUE, and PACT failures are design feedback, not cleanup.
3. **Refactor** with the tests green; `ponytail` the result.
4. Package scope: `pnpm exec turbo run test --filter ./src/draft/<kind>/<slug>` (exp proofs:
   `./src/draft/exp-proofs/<type>/<slug>`) or `pnpm --prefix <workspace> test`.

## Outer loop (branch, hours)

- Before every commit: `pnpm agent:check -- --staged` (policy auto-selects the draft-artifact,
  cascade, mirror, docs, and workspace lanes for the change).
- **Incremental checkins:** implementers commit after each red→green step, not once at the end.
- After committing: no-arg `pnpm agent:check` validates the latest commit.
- Whole-branch confidence (`--base=origin/main`) only at PR time; CI (docs.yml + hobo-ci pr-gate)
  is the arbiter the coordinator queries for the Done rule.
- Multi-layer work: parent merges lower-layer commits up the stack (`gh stack rebase --upstack`
  only while layers are unpushed) so upper-layer gates run on realistic bases.
- Design-relevant work: after independent review and current-head evidence,
  run the exact-six OptimizeXP council. Nay returns to the red/green loop;
  later commits or effective-base changes require refreshed evidence and a new
  unanimous vote. A diagnostic turn limit may return blocked, never approved.
- Never bypass hooks or gates; failures either get fixed or become explicit, ADR-backed waivers
  (billing-budget exceptions are recorded on the PR + state file — see `stacked-prs.md`).

## Required lanes (first-class, non-negotiable)

- **Contract tests** — every service boundary (PACT); `test:contract:consumer|provider`.
- **Feature tests** — executable cucumber via `test:behavior`.
- **Perf tests** — `bench/*.bench.ts` execute (numbers advisory, committed for trend).
