# Cross-Cloud Junction mTLS Contract — Architecture Evidence

This draft package satisfies `scripts/check-architecture-guardrails.mjs`.

## Schema and constraints

- Protobuf data shapes: [`architecture/cross_cloud_junction_mtls_contract.proto`](./architecture/cross_cloud_junction_mtls_contract.proto)
- CUE constraints bound every protobuf type in [`architecture/cross_cloud_junction_mtls_contract.cue`](./architecture/cross_cloud_junction_mtls_contract.cue)
- PACT contract: [`architecture/pacts/cross_cloud_junction_mtls_contract.pact.json`](./architecture/pacts/cross_cloud_junction_mtls_contract.pact.json)

## Parse, don't validate

Untrusted cross-cloud input crosses one parser boundary in `planCrossCloudJunction` and becomes **parsed derived domain types**:

- `DeployableCrossCloudPlan` — frozen plan with tier-selected edges, policy results, and junction halves
- `CrossCloudInvokeResult` — SVID-authorized invoke outcome from `invokeCrossCloudService`

Downstream callers receive these parsed derived types; they do not re-validate raw bind-edge DTOs.

## Event architecture

| Role | Name |
|---|---|
| **Command** | `junction.PlanCrossCloudConnectivity`, `link.InvokeCrossCloud` |
| **Event** | `junction.ConnectivityInferred`, `connectivity.PolicyAllowed`, `connectivity.PolicyBlocked`, `link.Called` |
| **Actor** | Junction connectivity planner aggregate |
| **Event store** | Append-only platform event log (design-time boundary only in this POC) |
| **Materialized view / projection** | Cross-cloud bind-edge annotations + per-Yard half deliveries |
| **Snapshot** | Deployable plan returned by `planCrossCloudJunction` |
| **Read store** | Annotated topology edges queried by planners and invoke seam |

No runtime engine, projector, or event store is implemented here; this document names the command/event/actor/projection boundaries for production `@hobo/junctions`.
