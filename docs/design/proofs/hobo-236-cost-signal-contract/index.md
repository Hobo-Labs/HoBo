# HOBO-236 Cost Signal Contract Proof

## Issue

HOBO-236 — Define the CreditLedger + metering cost-signal contract (`cost.json`,
`meter.*`/`spend.*`/`credit.*` events).

## Design References

- [PLAN-05 reliability/observability/cost](../../reliability-observability-cost.md#plan-05)
- [PLAN-11 data-plane event log](../../data-plane.md#plan-11)
- [ADR-0039 metering, quota, cost attribution](../../adr/02-identity-security.md#adr-0039)
- [ADR-0071 Dispatcher credit/budget-aware routing](../../adr/01-architecture-core.md#adr-0071)

## Proof Surface

- `src/draft/technical-proofs/cost-signal-contract` defines the versioned `cost.json` provider signal, typed
  metering/spend/credit event schemas, and deterministic `CreditLedgerView` snapshot serialization.
  The spend schema includes the runaway-spend circuit breaker and degradation lifecycle events named
  in ADR-0039.
- The focused test suite covers valid tiered and region-keyed prices, typed event round trips,
  replay-pinned ledger snapshots, mixed-currency rejection, reset-boundary splitting, invalid unit
  prices, missing plan regions, undeclared tier keys, and undeclared region keys.

## Scope Boundary

This proof deliberately stops at the schema contract. MeteringView projection logic, Dispatcher
ranking/reservation-CAS, and billing reconciliation remain out of scope for their own slices.
