# Error-budget deploy gate contract POC

Independent proof for HOBO-303.

This package composes the SLO computation output, policy plane, deployment
strategy saga, and flag plane into a pure error-budget deploy-gate boundary.
Callers pass a deploy request plus a fresh SLO snapshot. The gate emits a
replayable `policy.Decided` event for the `can-deploy` dimension, and an
auto-revert obligation handler turns `slo.BudgetBurned` into rollout or flag
revert events.

## Contract boundaries

- In scope: `can-deploy` error-budget decisions, apply-time SLO recheck,
  freeze recovery, recovery hysteresis, audited break-glass, rollout
  auto-revert events, feature-flag auto-revert events, and escalation when
  auto-revert fails.
- Consumed but not owned: SLO snapshot computation, `slo.BudgetBurned` signal
  production, policy-engine obligation creation, deployment strategy saga
  execution, and flag-plane mutation.
- Out of scope: SLO math, policy-language evaluation, provider deployment
  adapters, spend/degradation controls, and real runtime scheduling.

## Proof

```powershell
npm.cmd --prefix src\draft\technical-proofs\error-budget-deploy-gate-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Error Budget Deploy Gate Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
