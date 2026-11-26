# SLO computation engine contract POC

Independent proof for HOBO-277.

This package turns the HOBO-111 SLO-as-code contract into a pure computation
boundary. A caller supplies an SLO definition and an `SLISource` port that
returns ratio samples. The engine evaluates the objective window, computes
remaining error budget, evaluates fast and slow burn-rate windows, and emits
the existing `slo.BudgetBurned` event shape when a burn is present.

## Contract boundaries

- In scope: `SLISource` ratio samples, half-open evaluation windows, objective
  budget math, fast and slow burn-rate thresholds, built-in deploy success and
  control-plane availability SLOs, fail-closed no-data/stale/zero-traffic
  handling, and `slo.BudgetBurned` event materialization.
- Consumed but not owned: the HOBO-111 SLO declaration and event envelope
  contract.
- Out of scope: metrics ingestion, alert routing, deploy-freeze gates,
  auto-rollback, and runtime scheduling.

## Proof

```powershell
npm.cmd --prefix src\draft\technical-proofs\slo-computation-engine-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Slo Computation Engine Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
