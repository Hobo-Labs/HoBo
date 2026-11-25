# Admin Support Break-Glass Boundaries - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and
how its records map onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package's boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted input is
parsed once at the boundary into derived break-glass policy/session types, and
downstream consumers receive those parsed types instead of re-checking raw
request text or unbounded DTOs. The CUE constraints bound the same derived types
so malformed policy records are rejected at parse time rather than passed
downstream.

## Event Architecture

The package's accepted record is the read model behind a small event flow:

- **Command** - a request to record or evaluate a break-glass boundary decision.
- **Event** - successful commands append `breakglass.*` audit facts.
- **Actor** - the owning emergency-access aggregate applies events in order.
- **Event store** - accepted events are appended to the platform event store as
  the durable source of truth.
- **Materialized view / projection** - a projection folds the event store into
  current emergency-access state, notification posture, and revocation status.
- **Snapshot** - the accepted boundary record is the snapshot of that projection.
- **Read store** - admin, support, audit, and security surfaces query that read
  store rather than raw event logs.

No runtime engine, projector, UI, access broker, or event store is implemented
here; this is a design-time contract that names the command, event, actor,
projection, PACT, protobuf, and CUE boundaries so later implementation inherits
consistent vocabulary.
