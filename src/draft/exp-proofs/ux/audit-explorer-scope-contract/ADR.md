# Audit Explorer Scope Contract - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and
how its records map onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package's read-only boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted scope
input is parsed once at the boundary into derived domain types, and downstream
consumers receive those parsed domain types instead of re-checking broad raw
objects. The CUE constraints bound the same derived types so malformed input is
rejected at parse time rather than passed downstream.

## Event Architecture

The package's accepted record is the read model behind a small event flow:

- **Command** - a request to record or change the accepted Audit Explorer scope
  state.
- **Event** - a successful command appends an audit-explorer scope event to the
  log.
- **Actor** - the owning aggregate applies events in order.
- **Event store** - accepted events are appended to the platform event store as
  the durable source of truth.
- **Materialized view / projection** - a projection folds the event store into
  the read model consumers query.
- **Snapshot** - the accepted record is the snapshot of that projection.
- **Read store** - downstream audit, support, governance, and security surfaces
  query that read store rather than the raw event log.

No runtime engine, projector, UI, search index, export service, or event store
is implemented here; this is a design-time contract that names the command,
event, actor, projection, PACT, protobuf, and CUE boundaries so later
implementation inherits consistent vocabulary.
