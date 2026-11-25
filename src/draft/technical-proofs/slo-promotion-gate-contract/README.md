# SLO promotion-gate contract POC

This draft pins the `hobo:delivery` promotion-policy seam that consumes Reliability-owned SLO state.
It is intentionally small and independent of the unmerged delivery-port POC: the Harness reads a
Reliability snapshot, pins its `seq`, and evaluates a pure `promote | hold | rollback` verdict.

## Contract

- `resolvePromotionPolicy(policy, reliabilitySnapshot)` copies each referenced SLO burn-rate snapshot
  into a versioned `hobo.slo-promotion-gate/v1` decision input.
- `evaluatePromotionGate(resolvedInput)` is pure over the pinned input. Healthy SLOs promote, stale or
  unavailable SLO reads hold fail-safe, and Golden-suite failures roll back.
- `createGateDecision(resolvedInput, ids)` emits `delivery.PromotionGateDecided` with the pinned input
  and a deterministic SHA-256 input hash.

## Scope boundary

This POC does not declare SLOs, compute burn rates, run metric analysis, or implement the rollback saga.
Those remain Reliability and delivery-engine responsibilities. This package only defines the
consumption contract between the two subsystems.

## Verify

```powershell
npm.cmd --prefix src\draft\technical-proofs\slo-promotion-gate-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Slo Promotion Gate Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
