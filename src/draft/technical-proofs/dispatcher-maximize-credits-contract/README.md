# Dispatcher Maximize-Credits Contract POC

Independent POC for HOBO-363, HOBO-286, and HOBO-379. It pins the M2 Dispatcher ranking contract from
[ADR-0071](../../../../docs/design/adr/01-architecture-core.md#adr-0071) for placement and CI/build
dispatch decisions that consume a pinned `CreditLedgerView@seq`.

## What This Proves

- `createDispatcherRegistry()` is the runner/build-machine registration seam; only registered
  candidates are eligible for `dispatch.Decided`.
- `decideDispatch()` ranks a CI job/build-machine request by effective marginal cost under
  `maximize-credits` and records `dispatch.Decided` with the pinned ledger seq, balance hash, and
  per-candidate rationale.
- `replayDispatchDecision()` reuses the serialized candidates and `CreditLedgerView` input to prove
  deterministic replay of the same pick and event body.
- `createReservationLedger()` + `decideAndReserveDispatch()` prove the reservation-CAS seam: a stale
  ledger `seq` conflicts, refreshes the pinned snapshot, re-ranks, and reserves without
  double-spending free headroom.
- The reservation ledger records reserve/confirm/release/expire lifecycle proof events and restores
  headroom on failed or timed-out dispatch reservations.
- Recorded hysteresis input can hold the incumbent when a challenger is only near-equal, and the
  held rationale is surfaced in the decision and `dispatch.Decided` candidates.
- `decidePlacement()` applies the same cost-aware ranker to resource placement and records
  `match.Decided` with objective `maximize-credits`.
- Absent or invalid credit facts degrade to declared min-cost ranking instead of throwing or chasing
  untrusted free-tier claims.
- Budget caps and spend-to-date headroom keep over-cap cheap candidates behind affordable
  candidates.
- Adversarial fixtures cover rate-limited free tiers, switching-cost/egress penalties, expiring
  credits, misdeclared free tiers, and the no-registered-candidates fail-closed path.

## Scope Boundary

This package is a deterministic contract proof. It does not implement provider adapters, traffic
routing, live cost event production, durable EventStore persistence, or production dispatcher
workers. The reservation ledger is an in-memory contract seam that proves the CAS/re-rank behavior
HOBO-286 requires and the lifecycle hardening HOBO-379 adds.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\dispatcher-maximize-credits-contract test
npm.cmd --prefix src\draft\technical-proofs\dispatcher-reservation-hardening-contract test
npm.cmd test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Dispatcher Maximize Credits Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
