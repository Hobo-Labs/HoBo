# HOBO-286 CreditLedger Dispatcher Reservation Proof

This proof backs [PLAN-05](../../reliability-observability-cost.md#plan-05) and
[ADR-0071](../../adr/01-architecture-core.md#adr-0071) for the `maximize-credits`
Dispatcher slice.

The executable POC in
[`src/draft/technical-proofs/dispatcher-maximize-credits-contract`](../../../../src/draft/technical-proofs/dispatcher-maximize-credits-contract)
extends the existing Dispatcher ranking proof with reservation-CAS and recorded hysteresis behavior.

## Acceptance Evidence

- Given a pinned `CreditLedgerView@seq`, the Dispatcher selects the max-credit provider and records
  `dispatch.Decided` with ledger seq, reservation id, balance hash, candidate cost, and rationale.
- Replaying serialized dispatch inputs remains deterministic against the pinned ledger snapshot.
- A stale reservation attempt detects the ledger `seq` conflict, refreshes the snapshot, re-ranks,
  and reserves a different provider without double-spending free headroom.
- Hysteresis keeps an incumbent when the challenger savings are below the recorded threshold, and
  records the held rationale in the decision and dispatch candidate.

## Adversarial Evidence

- Two dispatches racing the last free unit cause one successful reservation and one CAS refresh.
- A moved ledger does not mutate the stale decision; the second attempt re-ranks against the new
  pinned `seq`.
- Providers with no usable credit fall back to deterministic list-price ranking.
- De-registered providers stay outside the candidate set and fail closed when no registered
  candidate remains.

## Scope Boundary

This is an in-memory contract proof only. It does not implement provider adapters, live cloud calls,
traffic routing, persistent EventStore writes, production dispatcher workers, budget-cap policy
enforcement, or shared-resource attribution.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\dispatcher-maximize-credits-contract test
npm.cmd test
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
```
