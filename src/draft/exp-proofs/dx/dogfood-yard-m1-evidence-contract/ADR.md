# Dogfood Yard M1 Evidence Contract - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and how its records map
onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted dogfood evidence input is
parsed once at the boundary into derived domain types, and downstream consumers receive those
parsed types instead of repeatedly checking raw fields. CUE constraints bound the same derived
types so malformed input is rejected at parse time rather than passed downstream.

## Event Architecture

The package's accepted record is the read model behind a small event flow:

- **Command** - a request to record or change the Dogfood Yard M1 evidence gate.
- **Event** - a successful command appends a `dogfood.EvidenceGateAccepted` event.
- **Actor** - the Dogfood Yard evidence aggregate applies events in order.
- **Event store** - accepted evidence-gate events are appended to the platform event store as the
  durable source of truth.
- **Materialized view / projection** - a projection folds evidence events into the Dogfood Yard
  M1 evidence read model.
- **Snapshot** - the accepted M1 record is the snapshot of that projection.
- **Read store** - release cutline, release notes, admin, bootstrap, and reliability surfaces query
  that read store rather than raw events.

No Yard runtime, provider adapter, admin UI, bootstrap command, release-note workflow, projector, or
event store is implemented here; this is a design-time contract that names the command, event,
actor, and projection boundaries so later implementation inherits a consistent vocabulary.
