# Support Workflow Scope Contract — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and
how its records map onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted support
scope input is parsed once at the boundary into derived domain types, and
downstream consumers receive those parsed types instead of repeatedly checking
raw fields. CUE constraints bound the same derived types so malformed input is
rejected at parse time rather than passed downstream.

## Event Architecture

The package's accepted record is the read model behind a small event flow:

- **Command** — a request to record or change the Support Workflow M0 scope.
- **Event** — a successful command appends a `support.ScopeAccepted` event.
- **Actor** — the Support Workflow scope aggregate applies events in order.
- **Event store** — accepted scope events are appended to the platform event
  store as durable source of truth.
- **Materialized view / projection** — a projection folds scope events into the
  support workflow acceptance read model.
- **Snapshot** — the accepted M0 record is the snapshot of that projection.
- **Read store** — downstream support tooling and release-readiness surfaces
  query that read store rather than raw events.

No runtime engine, projector, support tool, or event store is implemented here;
this is a design-time contract that names the command, event, actor, and
projection boundaries so later implementation inherits a consistent vocabulary.
