# FinOps Plane — Architecture Evidence

This package applies **parse, don't validate** at imported technical-proof
boundaries and exposes **derived types** (`PlanCostEstimate`, deploy gate
decisions, showback reconciliation) to callers.

## Schema and constraints

- Protobuf: [`finops_plane.proto`](./finops_plane.proto)
- CUE: [`finops_plane.cue`](./finops_plane.cue) — one constraint block per protobuf message
- PACT: [`../contracts/pacts/finops_plane_boundary.pact.json`](../contracts/pacts/finops_plane_boundary.pact.json)

## Event architecture

| Role | FinOps plane behavior |
|---|---|
| **Command** | `EvaluateFinOpsDeployGate` — policy plane evaluates a plan-time cost estimate against budgets/caps. |
| **Event** | `meter.UsageRecorded`, `policy.Decided`, `spend.CapGateEvaluated` — appended to the platform event log. |
| **Actor** | Budget/quota policy actor owns gate decisions; MeteringView projector owns usage folds. |
| **Event store** | Authoritative append-only log of metering and policy facts (mocked fixtures in this POC). |
| **Materialized view / projection** | `MeteringView` folds usage/cost counters; showback rows derive from the same projection. |
| **Snapshot** | Seq-pinned `MeteringView` snapshot and showback report totals at evaluation time. |
| **Read store** | Showback tenant/camp/bindle surfaces query the folded projection, not raw telemetry. |

Plan-time estimates are read-only **projections** over capability manifest `cost.json` and never mutate the event store.

## Parse, don't validate

Raw `cost.json`, plan profiles, policy inputs, and metering events are parsed
once by the imported technical proofs. This orchestration module accepts only
parsed **derived domain types** at its public seam (`estimatePlanCost`,
`evaluateFinOpsDeployGate`, `reconcileShowbackProjection`).
