# FinOps Plane Project POC — Architecture Evidence

This draft project composes existing FinOps technical proofs into one S6-06
vertical slice without duplicating their contracts.

## Schema And Constraints

- Protobuf shapes: [`architecture/finops_plane.proto`](./architecture/finops_plane.proto)
- CUE constraints: [`architecture/finops_plane.cue`](./architecture/finops_plane.cue)
- PACT boundary: [`contracts/pacts/finops_plane_boundary.pact.json`](./contracts/pacts/finops_plane_boundary.pact.json)

## Parse, Don't Validate

Untrusted `cost.json`, plan usage profiles, policy requests, and metering events
cross one parser boundary in each imported technical proof. This project only
orchestrates parsed outputs:

- `parseCostJson` / region coverage — `cost-signal-contract`
- `evaluateBudgetQuotaPolicy` — `budget-quota-policy-contract`
- `snapshotMeteringView` — `metering-view-projection-contract`
- `createShowbackReport` — `showback-attribution-contract`

## Event Architecture

Showback reads a **MeteringView** projection folded from `meter.UsageRecorded`
events. Budget gates emit **policy.Decided** and **spend.*** audit facts through
the budget/quota policy contract. Plan estimates are read-only projections over
capability manifest `cost.json` — no deploy side effects.

## Promotion Path

When S6-01 acceptance record merges, promote stable seams into `packages/cloud`
FinOps modules while keeping this draft POC as traceability evidence for HOBO-661.
