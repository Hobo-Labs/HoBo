# `@hobo/control-api` architecture

## Layers

```
HTTP / SSE  →  route map  →  @hobo/management pure functions  →  HOBO_HOME event stores
```

## Schema and constraints

- Protobuf records live in [`data-models/control_api.proto`](./data-models/control_api.proto).
- CUE constraints in [`data-models/control_api.cue`](./data-models/control_api.cue) bound every protobuf message.
- PACT consumer evidence under [`contracts/pacts/`](./contracts/pacts/).

## Parse, don't validate

HTTP JSON bodies cross one **parse, don't validate** boundary in `dispatch`:
query/body strings become management command inputs; responses are already
frozen **derived types** from `@hobo/management` (never re-validated ad hoc in handlers).

## Event architecture

- **Command** — HTTP POST routes map 1:1 to management commands (station/connection/rails).
- **Events** — never written here; append happens inside `@hobo/management` / StationService / ConnectionService.
- **Actor** — control-api process is a thin adapter actor; management owns aggregate mutation.
- **Event store** — `HOBO_HOME` event logs via management context.
- **Materialized view / projection** — `GET /v1/yard/snapshot` and SSE `yard` events stream management projections.
- **Snapshot** — JSON `YardProjectionSnapshot` per poll/SSE tick.
- **Read store** — local HTTP responses; no parallel read model.

## Endpoints (v0)

| Method | Path | Management op |
|---|---|---|
| POST | `/v1/station/init` | `stationInit` |
| POST | `/v1/station/up` | `stationUp` |
| POST | `/v1/station/down` | `stationDown` |
| GET | `/v1/station/status` | `stationStatus` |
| GET | `/v1/station/rails` | `stationRailsList` |
| POST | `/v1/station/rails/publish` | `stationRailsPublish` |
| POST | `/v1/station/rails/approve` | `stationRailsApprove` |
| POST | `/v1/station/rails/activate` | `stationRailsActivate` |
| POST | `/v1/connection/create` | `connectionCreate` |
| POST | `/v1/connection/authorize` | `connectionAuthorize` |
| GET | `/v1/connection` | `connectionList` |
| GET | `/v1/connection/:id` | `connectionGet` |
| POST | `/v1/connection/:id/revoke` | `connectionRevoke` |
| GET | `/v1/broker/status` | `brokerStatus` |
| GET | `/v1/doctor` | `doctorSnapshot` |
| GET | `/v1/yard/snapshot` | `projectYardSnapshot` |
| GET | `/v1/yard/stream` | SSE of yard snapshots |

## Auth

Local-first: optional `x-hobo-principal` / `x-hobo-tenant` headers map to actor.
Default fixture mode mirrors ADR-0111 no-auth local read path.
