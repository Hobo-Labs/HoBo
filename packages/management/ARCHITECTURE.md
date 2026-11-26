# `@hobo/management` architecture

## Role

Shared **management surface** for control-plane ops. Pure functions over
`HOBO_HOME`-style event logs. Consumers: `hobo` CLI, MCP stdio, `@hobo/control-api`.

## Schema and constraints

- Protobuf records live in [`data-models/management.proto`](./data-models/management.proto).
- CUE constraints in [`data-models/management.cue`](./data-models/management.cue) bound every protobuf message.
- PACT consumer evidence under [`contracts/pacts/`](./contracts/pacts/).

## Parse, don't validate

`createManagementContext` plus `projectYardSnapshot` form the **parse, don't validate**
boundary for control-plane projections: untrusted event log lines fold through
`StationService` / `ConnectionService` into frozen **derived types**
(`YardProjectionSnapshot`, `PublicConnectionView`, `RailPublicView`, `MeteringView`).
Callers receive derived domain types — never re-check raw JSON maps after fold.

## Event architecture

- **Command** — station init/up/down/status/rails\*; connection create/authorize/list/get/revoke/rotate; broker status; doctor.
- **Events** — Station family (`station.Created|Configured|Closed|IdentityRotated`, `rail.Published|Approved|Activated|Deactivated|Retired`) and Connection family (`connection.Created|Authorized|Revoked|…`) only — no invented events.
- **Actor** — StationService / ConnectionService own their aggregates; management is a pure façade.
- **Event store** — append-only JSONL under `HOBO_HOME/stations/<id>/` and `HOBO_HOME/connections/`.
- **Materialized view / projection** — `foldStationEvents` + connection list views; `projectYardSnapshot` is the Yard projection.
- **Snapshot** — `YardProjectionSnapshot` for the game UI and control API.
- **Read store** — occupancy + rails + connections + metering derived views served to CLI/MCP/SSE.

## Boundaries

| Boundary | Contract |
|---|---|
| In | `ManagementHome` (hoboHome path + optional injectables) + command inputs |
| Out | `ManagementResult` envelopes + projection snapshots |
| Events | Station + Connection event schemas from `@hobo/stations` / `@hobo/identity` |

## Event-sourced only

Mutations append via `StationService` / `ConnectionService`. UI never invents state.
