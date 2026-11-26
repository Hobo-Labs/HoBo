# HOBO-612 hobo dev local loop — Architecture Evidence

Draft POC for S1-22 (`hobo dev` offline local loop). Promotes to `packages/cli/`.

## Schema and constraints

- Protobuf records and `dev.*` event family: [`data-models/dev_loop.proto`](./data-models/dev_loop.proto)
- CUE constraints: [`data-models/dev_loop.cue`](./data-models/dev_loop.cue)
- PACT boundaries: [`contracts/cli-dev-runtime-local.pact.json`](./contracts/cli-dev-runtime-local.pact.json), [`contracts/cli-dev-codegen.pact.json`](./contracts/cli-dev-codegen.pact.json)

## Parse, don't validate

Untrusted input crosses one parser boundary:

- `parseDevPort`, `parseDevStateSnapshot`, `parseDevSessionOptions` in `src/types.ts`
- Invalid port, schema version, or flag values are rejected at construction; core session code accepts only parsed types.

## Event architecture (CQRS)

| Role | Implementation |
| --- | --- |
| **Command** | `startDevSession`, `reloadHandler`, `flushWatchCodegen`, `handleDevRequest` |
| **Event** | `dev.SessionStarted`, `dev.RequestServed`, `dev.HandlerReloaded`, `dev.ReloadFailed`, `dev.CodegenRan`, `dev.SessionStopped` |
| **Actor** | `DevSession` owns append-only event log |
| **Event store** | `.hobo/dev-events.jsonl` append-only log |
| **Projection** | `projectDevState(events)` folds events into session state |
| **Snapshot** | `.hobo/dev-state.json` (`hobo.dev-state/v1`) written from projection |
| **Read store** | `DevStateStore.read()` replays events or loads snapshot then validates sequence |

Session code never mutates the snapshot directly; snapshots are projections of appended events.
