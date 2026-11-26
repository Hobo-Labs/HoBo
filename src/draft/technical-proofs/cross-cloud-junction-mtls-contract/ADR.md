# Cross-Cloud Junction mTLS Contract — Architecture Evidence

Draft package for HOBO-642. Composes junction connectivity planning, tier IR, policy enforcement, cost feedback, and mTLS data-path contracts behind a single cross-cloud invoke seam.

## Schema and constraints

- Protobuf: [`architecture/cross_cloud_junction_mtls_contract.proto`](./architecture/cross_cloud_junction_mtls_contract.proto)
- CUE: [`architecture/cross_cloud_junction_mtls_contract.cue`](./architecture/cross_cloud_junction_mtls_contract.cue)
- PACT: [`architecture/pacts/`](./architecture/pacts)

## Parse, don't validate

`planCrossCloudJunction` parses topology + bind edges once, derives tier plans and junction halves, and returns frozen deployable artifacts. `invokeCrossCloudService` accepts only parsed deployable plans plus an mTLS handshake contract — no raw DTO re-validation downstream.

## Event vocabulary

- **Command** — `junction.PlanCrossCloudConnectivity`
- **Event** — `junction.ConnectivityInferred`, `connectivity.PolicyAllowed|PolicyBlocked`, `link.Called`
- **Actor** — Junction planner aggregate (pure fold over Yard manifests)
- **Projection** — annotated bind edges + per-Yard half deliveries
- **Snapshot** — deployable cross-cloud plan returned by `planCrossCloudJunction`

No runtime engine is implemented; this names boundaries for production `@hobo/junctions`.
