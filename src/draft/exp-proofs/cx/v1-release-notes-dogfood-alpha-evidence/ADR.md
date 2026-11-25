# V1 Release Notes Dogfood Alpha Evidence - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how the M1 dogfood/alpha
gate data is parsed and how accepted gate records map onto the platform event
flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted gate
input is parsed once into derived domain types for evidence items, blockers,
accepted risks, follow-ups, and parent-readiness updates. Downstream consumers
receive those parsed domain types instead of re-checking raw DTO fields. The CUE
constraints bound the same derived types so malformed evidence records are
rejected at parse time rather than passed downstream.

## Event Architecture

The accepted M1 gate record is the read model behind a small event flow:

- **Command** - a request to record or revise the dogfood/alpha evidence gate.
- **Event** - a successful command appends `releaseNotes.GateAccepted` or
  `releaseNotes.GateRejected` events.
- **Actor** - the Release Notes Gate actor applies gate events in order.
- **Event store** - accepted events are appended to the platform event store as
  the durable source of truth.
- **Materialized view / projection** - a projection folds gate events into the
  current readiness-gate view.
- **Snapshot** - the accepted gate record is the snapshot of that projection.
- **Read store** - release-readiness, docs, and cutline consumers query the read
  store rather than raw gate events.

No runtime actor, projector, or event store is implemented here; this is a
design-time contract that names the command, event, actor, projection, snapshot,
and read-store boundaries for later implementation.
