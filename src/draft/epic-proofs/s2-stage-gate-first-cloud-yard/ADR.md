# S2 Stage Gate Drill — Architecture Evidence

Draft package for HOBO-626. Documents how the stage-gate drill parses contract
input once and names the event-sourced deployment lifecycle vocabulary.

## Schema And Constraints

- Protobuf shapes: [`architecture/`](./architecture).
- CUE constraints bound every protobuf type.
- PACT contract: [`architecture/pacts/`](./architecture/pacts).

## Parse, Don't Validate

Untrusted drill configuration crosses one parser boundary via
`createS2StageGateDrillContract()` + `validateS2StageGateDrillContract()`.
Downstream simulators receive frozen contract objects as parsed derived types,
not raw DTOs plus repeated boolean checks.

## Event Architecture

The drill models Yard deployment as append-only events:

- **Command** — `Deploy` / `Promote` / `Destroy` through the Gateway.
- **Event** — `deployment.*`, `exec.*`, `saga.*`, `policy.*`, `compat.*` append to the event store.
- **Actor** — ResourceActor and Orchestrator emit events; no direct read-model mutation.
- **Event store** — append-only log is the durable source of truth for resume.
- **Projection** — `reconstructDeploymentTimeline()` folds the log into a materialized view.
- **Snapshot** — timeline entries are snapshots of deployment phase state.
- **Read store** — drill consumers query the reconstructed timeline read store, not raw actors.

No runtime engine is implemented here; this is design-time evidence for S2-11.
