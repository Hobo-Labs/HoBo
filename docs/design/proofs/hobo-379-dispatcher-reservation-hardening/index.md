# HOBO-379 Dispatcher Reservation Hardening Proof

This proof backs [PLAN-04](../../control-plane.md#plan-04),
[PLAN-05](../../reliability-observability-cost.md#plan-05), and
[ADR-0071](../../adr/01-architecture-core.md#adr-0071).

The executable hardening harness in
[`src/draft/technical-proofs/dispatcher-reservation-hardening-contract`](../../../../src/draft/technical-proofs/dispatcher-reservation-hardening-contract)
extends the existing
[`dispatcher-maximize-credits-contract`](../../../../src/draft/technical-proofs/dispatcher-maximize-credits-contract)
with reservation lifecycle and burst-safety assertions.

## Acceptance Evidence

- N concurrent dispatches reading the same stale `CreditLedgerView@seq` cannot consume more free-tier
  units than the ledger allotment; later dispatches re-rank to paid list-price headroom.
- The reservation lifecycle is recorded as `dispatch.ReservationReserved`,
  `dispatch.ReservationConfirmed`, `dispatch.ReservationReleased`, and
  `dispatch.ReservationExpired` proof events.
- Dispatch failure releases a pending reservation and restores reserved free headroom.
- A reserved-but-never-confirmed dispatch expires and releases without a second spend.
- Confirmed reservations are not released by timeout cleanup.
- Late provider usage cannot confirm an expired reservation or spend restored headroom.
- Existing replay tests still prove `dispatch.Decided` is deterministic from pinned inputs.

## Adversarial Evidence

- A burst of five concurrent jobs against two free units reserves only two free units.
- A stale snapshot CAS conflict refreshes and re-ranks before reserving.
- Pending reservations fail closed to release or expiry; confirmed reservations remain spent.
- Late provider usage after expiry is rejected as `not-confirmable`.
- Reservation release restores the same provider/dimension headroom instead of mutating another
  account.

## Scope Boundary

This is an in-memory contract proof. It does not implement a production EventStore, provider
adapters, live provider-usage reconciliation, or long-running dispatcher workers. The hardening
surface proves the required reservation semantics before those runtime pieces exist.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\dispatcher-reservation-hardening-contract test
npm.cmd --prefix src\draft\technical-proofs\dispatcher-maximize-credits-contract test
npm.cmd test
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
node scripts\validate-sdk-contracts.ts
node scripts\validate-deployment-set-delta.ts
```
