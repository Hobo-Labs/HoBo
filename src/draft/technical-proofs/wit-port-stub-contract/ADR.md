# WIT Port Stub Contract — Architecture Evidence

This draft package carries architecture-guard evidence for HOBO-651 (`stub()` behind
any WIT port).

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted port call
payloads are parsed once at the boundary into derived domain types (`ChargeInput`,
`ChargeOutput`, `StubRecordedTraceEntry`), and downstream consumers receive those
parsed, derived types instead of re-checking raw input. The CUE constraints bound
the same derived types so malformed input is rejected at parse time rather than
passed downstream.

## Event Architecture

The package's recorded trace is the read model behind a small event flow:

- **Command** — `stubPort` / `callImport` requests a typed stub invocation.
- **Event** — successful calls append `stub.Recorded` and `link.Called` to the log.
- **Actor** — the stub membrane aggregate applies events in order.
- **Event store** — accepted events are appended to the platform event store as
  the durable source of truth (Camp persistence is out of scope here).
- **Materialized view / projection** — a projection folds the event store into the
  replayable trace consumers export via `exportRecordedTrace`.
- **Snapshot** — the exported trace is the snapshot of that projection.
- **Read store** — the S1-12 replay harness queries that read store rather than the
  raw event log.

No runtime engine, projector, or Camp event store is implemented here; this is a
design-time contract that names the command, event, actor, and projection boundaries
so later `packages/runtime/` promotion inherits a consistent vocabulary.
