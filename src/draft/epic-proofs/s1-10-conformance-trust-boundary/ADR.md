# S1-10 Conformance Trust Boundary — Architecture Evidence

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- PACT contracts under [`pacts/`](./pacts) record suite boundaries.

## Parse, Don't Validate

This package applies **parse, don't validate**: untrusted manifest and report
input crosses `parseComponentHostManifest` / `parseRuntimePortReport` once into
**derived domain types**; check implementations accept only those parsed types.

## Event Architecture

Checkout durability proof exercises the full event flow:

- **Command** — append checkout commands to EventStore streams.
- **Event** — `checkout.*` domain events append to the event store.
- **Actor** — ActorHost leases fence cart actor writes.
- **Event store** — append-only log is durable source of truth.
- **Materialized view / projection** — checkout fold is the projection.
- **Snapshot** — live fold state is the current snapshot.
- **Read store** — replay fold reads the same event log into the read store.

Conformance reports are read models over check results, not direct mutations.
