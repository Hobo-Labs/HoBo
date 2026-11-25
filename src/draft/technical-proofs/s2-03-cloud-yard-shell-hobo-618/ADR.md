# Cloud Yard Shell — Architecture Evidence

Draft package for HOBO-618. Documents how the Yard shell Gateway turns
authenticated commands into append-only events and how the deployment timeline
projection folds those events under NFR-008 replay equivalence.

## Schema and constraints

- Protobuf shapes: [`architecture/cloud_yard_shell.proto`](./architecture/cloud_yard_shell.proto)
- CUE constraints: [`architecture/cloud_yard_shell.cue`](./architecture/cloud_yard_shell.cue)
- Gateway PACT: [`architecture/pacts/gateway_boundary.pact.json`](./architecture/pacts/gateway_boundary.pact.json)

## Parse, don't validate

`parseDeployCommand` and `authenticate` are the only ingress parsers. Downstream
Gateway, event store, and projection host code consume **parsed derived types**
— `DeployCommand`, `Principal`, and `TimelineState` — not raw HTTP/RPC bodies.

## Event architecture

| Role | This package |
| --- | --- |
| **Command** | `Deploy` via REST `/v1/commands/deploy` or RPC `Deploy` |
| **Event** | `deployment.DeployRequested` appended to `deployment:<key>` stream |
| **Actor** | Yard control-plane aggregate applies commands by emitting events only |
| **Event store** | Mock `@hobo/runtime-postgres` append-only streams |
| **Materialized view / projection** | `foldDeploymentTimeline` folds events into timeline entries |
| **Snapshot** | `projectionHost.liveState()` is the cached snapshot at current log position |
| **Read store** | `GET /v1/read-models/deployment-timeline` queries the snapshot read store |

No live Postgres, Planner, or Orchestrator is implemented here. Production
promotion to `packages/cloud/` inherits this vocabulary.
