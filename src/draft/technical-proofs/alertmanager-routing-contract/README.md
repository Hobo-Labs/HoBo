# AlertManager routing contract POC

Independent proof for HOBO-281.

This package pins the alerting boundary that consumes SLO burn, health, drift,
and spend signals and produces event-sourced `alert.*` routing decisions. The
contract keeps the AlertManager-style model pure: grouping, deduplication,
silencing, inhibition, routing, receiver dispatch, and replay explanations are
all evaluated without owning SLO computation, spend breaker sagas, or status
page rollups.

## Contract boundaries

- In scope: `slo.BudgetBurned` and health/drift/spend-like firing or resolved
  signals, grouping keys, dedup windows, auto-expiring silences, inhibition
  rules, route matchers, receiver ports, durable retry decisions, storm caps,
  and replayable `alert.*` explanations.
- Consumed but not owned: SLO computation, health/drift/spend signal
  production, provider receiver implementations, and the event envelope shape.
- Out of scope: SLO calculation, spend breaker or graceful-degradation sagas,
  status-page rollup, and runtime scheduling.

## Proof

```powershell
npm.cmd --prefix src\draft\technical-proofs\alertmanager-routing-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Alertmanager Routing Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
