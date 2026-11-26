# Reliability SLA Rollup Contract POC

Independent proof for HOBO-334.

This package pins the GA reliability SLA rollup boundary from Plan 05 and Plan
49 without implementing the SLO engine, AvailabilityView internals, or dashboard
UI. It models the contract data those systems exchange so the target set,
restore drill, status page rollup, and incident surfacing are executable on a
branch.

## Contract Surface

- `ratifyReliabilityTargets(evidence)` turns the built-in reliability target set
  into SLO-engine assertions and marks targets `ratified` or `provisional`.
- `evaluateRestoreDrill(drill)` checks the full-Yard RTO target against a
  production-scale event-log replay.
- `foldReliabilityRollup(events)` rebuilds the operations/status rollup from the
  event log only, showing observed SLOs next to AvailabilityView estimates.
- `rollbackRollupMutation(event)` proves public status-page publication has a
  reversible mutation.

## Scope Boundaries

Included:

- Built-in SLA target ratification and provisional warnings.
- Production-scale RTO drill acceptance and false-pass rejection.
- Project/environment rollup with observed SLO and architecture estimate fields.
- Incident surfacing when a target or tenant-scoped subcomponent burns.
- Stale status reads rendering `delayed/unknown` instead of green.
- Deterministic replay from event facts.

Excluded:

- SLO computation internals and burn-rate math.
- AvailabilityView graph composition internals.
- Dashboard or public status-page frontend rendering.
- Cost-induced degradation handling beyond incident-class surfacing.

## Proof

```powershell
npm.cmd --prefix src\draft\technical-proofs\reliability-sla-rollup-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Reliability Sla Rollup Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
