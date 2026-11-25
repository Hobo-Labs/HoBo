---
type: Reference
title: "HOBO-665 Stage-6 Acceptance Gate Proof"
description: "Proof note for the scripted Stage-6 acceptance drill closing v1 GA readiness."
tags: [hobo, proof, stage-gate, s6]
---

# HOBO-665 Stage-6 Acceptance Gate Proof

Independent draft POC for **S6-10**: close the Stage-6 gate — and v1 GA readiness — as a scripted acceptance drill per [requirements.md Release criteria Stage 6](../../../archive/requirements/requirements.md).

## Evidence

- Epic proof package: [`stage-6-acceptance-gate`](../../../../src/draft/epic-proofs/stage-6-acceptance-gate/README.md)
- Drill orchestrator: `src/stage-6-acceptance-drill.ts`
- Fixture harness: `simulation/fixtures/stage-6-acceptance-fixture.json`

## Acceptance (provable on branch)

1. Canary regression auto-rolls-back — `greenDrill` + adversarial `rollbackCompensationFailure`
2. Plan-time cost within ±20% of fixture — `greenDrill` + `costOutOfTolerance`
3. DR rebuild < 15 min RTO from log replay — `greenDrill` + `drRtoExceeded`
4. Dashboard WCAG 2.1 AA + pseudo-loc audits green — `greenDrill` + `dashboardAuditFailure`
5. Four governance-plane evidence items — `greenDrill` + `governanceBypass`
6. Prior stage gates S0-S5 re-run green (ADR-0063) — `greenDrill` + `priorGateRegression`

Done when drill green in CI, evidence attaches to S6-01 acceptance record, v1 GA checklist complete.

## Verification

```bash
pnpm --prefix src/draft/epic-proofs/stage-6-acceptance-gate test
pnpm --prefix src/draft/epic-proofs/stage-6-acceptance-gate run simulate
```

## Scope note

Blocker slices S6-04/07/09 are Done (HOBO-659/662/664). This POC still mocks their seams for deterministic CI; production promotion replaces fixtures with merged subsystem adapters.

## Maintenance note

2026-07-02: Blockers HOBO-659 (PR #718), HOBO-662 (PR #723), and HOBO-664 (PR #722) are Done. Drill remains fixture-backed until production `packages/*` promotion.
