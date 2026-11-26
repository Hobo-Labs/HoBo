# CreditLedgerView Contract POC

Independent POC for HOBO-246. It pins the M1 `CreditLedgerView` projection skeleton used by the Dispatcher cost-routing decision input from ADR-0071.

## Contract Surface

- `snapshotCreditLedger(events, { seq, clock })` folds local `credit.*`, `meter.*`, and `spend.*` fixture events up to the requested log `seq`.
- The snapshot records `view: "CreditLedgerView"`, `seq`, a pinned `asOf` clock, stable `digest`, and per-provider/per-dimension accounts.
- Each account exposes `freeAllotment`, `consumed`, `freeHeadroom`, `currency`, and `listUnitCost`.
- `quoteEffectiveMarginalCost(snapshot, { providerId, dimension, units })` returns zero-cost free-headroom segments first, then list-price segments.
- `casRequiredForReservation: true` records the boundary that double-spend safety belongs to the later Dispatcher reservation-CAS slice.

## Fixture Events

This POC intentionally keeps fixture event shapes local:

- `credit.Registered`
- `credit.Reset`
- `credit.Exhausted`
- `meter.UsageRecorded`
- `spend.Recorded`

The canonical cost-signal event schema remains owned by HOBO-236. HOBO-246 only proves the fold semantics that consume those future facts.

## Scope Boundaries

Included:

- Effective marginal cost by provider/objective dimension.
- Reset-window arithmetic against a pinned wall clock.
- Snapshot isolation at `seq`.
- Zero while free headroom remains, list price after.
- Expiry and later-spend adversarial cases.

Excluded:

- Dispatcher selector/ranking and reservation-CAS.
- Budget-cap enforcement at the gate.
- Billing reconciliation.
- Canonical event schema publication.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\credit-ledger-view-contract test
npm.cmd test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Credit Ledger View Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
