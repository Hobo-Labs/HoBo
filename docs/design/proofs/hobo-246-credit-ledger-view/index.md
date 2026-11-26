# HOBO-246 CreditLedgerView Proof

This proof backs [PLAN-05](../../reliability-observability-cost.md#plan-05) and [ADR-0071](../../adr/01-architecture-core.md#adr-0071).

The branch adds `src/draft/technical-proofs/credit-ledger-view-contract`, an independent POC for the M1 credit-aware cost projection. It proves the Dispatcher can receive a deterministic `CreditLedgerView@seq` input without implementing the later selector, reservation-CAS, budget gate, or billing reconciliation.

## Acceptance Evidence

- Partially consumed free-tier fixtures quote `0` cost through remaining headroom and list price after the headroom segment.
- Replaying the same `snapshot(seq)` twice produces an identical snapshot digest and identical effective marginal cost quote.
- Reset-window crossing advances headroom deterministically from both the pinned log `seq` and pinned clock.
- Concurrent in-flight decisions reading the same snapshot see the same headroom and explicitly require reservation-CAS outside this projection.
- Spend-to-date after the snapshot `seq` does not retroactively change the pinned decision input.
- Credit expiry mid-window falls back to list price even though the reset window remains open.

## Scope Boundary

This POC uses local fixture event shapes for `credit.*`, `meter.*`, and `spend.*`. The canonical cost-signal contract remains owned by HOBO-236; this branch only proves the projection fold that consumes those future facts.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\credit-ledger-view-contract test
npm.cmd test
```
