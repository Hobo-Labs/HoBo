# ADR — Stage-6 acceptance drill (HOBO-665)

Draft package architecture-guard evidence. Blocker slices S6-04/07/09 are Done; production promotion replaces fixture adapters with their merged seams.

## Decision

Stage-6 gate closes via a **scripted acceptance drill** orchestrating six release criteria plus prior-gate re-run. This POC proves the drill shape with deterministic fixtures; production wires real subsystems behind the same check IDs.

## Evidence types

- `Stage6AcceptanceDrillResult` — drill outcome snapshot
- `PriorStageGateRecord` — per-stage S0-S5 re-run status
- `GovernanceEvidenceItem` — four governance-plane proofs

## ADR-0063 compliance

Drill fails if any prior gate record is not `pass`. Adversarial `priorGateRegression` scenario locks this behavior.

## Promotion path

Replace fixture adapters with merged blocker seams while keeping the same `AcceptanceCheckId` enum and PACT inventory:

- DR: `src/draft/technical-proofs/multi-region-dr-replay-contract` (HOBO-659)
- Dashboard: `src/draft/exp-proofs/ux/full-dashboard-projection-views-contract` (HOBO-662)
- Operator Crew: `src/draft/technical-proofs/s6-09-operator-crew-yard-services-contract` (HOBO-664)

## Cascade absorption

The dashboard proof's example-only JSON type assertion was removed to satisfy
the anti-slop boundary rule. No Stage-6 contract, fixture, or acceptance
criterion changes; the existing dashboard Pact and failure scenario remain the
rollup evidence.
