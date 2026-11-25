# HOBO-339 Saga Compensation and Credit Reconciliation Proof

This proof records the M0 spike for saga compensation correctness and
CreditLedger estimate-vs-actual reconciliation from [Plan 05](../../reliability-observability-cost.md#plan-05),
[ADR-0071](../../adr/01-architecture-core.md#adr-0071), and
[ADR-0039](../../adr/02-identity-security.md#adr-0039).

## Proof Surface

- [Draft package](../../../../src/draft/technical-proofs/saga-credit-reconciliation-spike/README.md)
- [Executable checks](../../../../src/draft/technical-proofs/saga-credit-reconciliation-spike/test/spike.test.ts)

## Proven Constraints

- Saga compensation must destroy only provisioned resources, in reverse topological order.
- Optional resource failure can be partial success when required resources remain healthy.
- Create-before-state-recorded interleavings need provider tags plus an orphan sweep.
- Failed or unknowable compensation must surface `needs-human` rather than success.
- Estimate-vs-actual reconciliation needs deterministic delta idempotency keys.
- Providers without billing APIs are estimate-only and cost-uncertain.
- Billing replay skips already-recorded deltas to avoid double-counting.

## Scope Boundary

The proof intentionally stops at recommendation and prototype level. It does not build
the production compensation engine, provider billing API adapter, spend breaker, or
Dispatcher routing implementation.

## Verification

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\saga-credit-reconciliation-spike test
```
