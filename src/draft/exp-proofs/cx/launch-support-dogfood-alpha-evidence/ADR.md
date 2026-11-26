# Launch Support Dogfood/Alpha Evidence - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and how its records map
onto the platform event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted support evidence input is
parsed once at the boundary into derived domain types. Downstream release-readiness consumers
receive parsed support evidence records, parsed support findings, and parsed cutline dependencies
instead of raw DTOs with repeated boolean checks.

## Event Architecture

The package's accepted M1 support evidence record is the read model behind a small event flow:

- **Command** - a request to record or change the Launch Support Desk M1 dogfood/alpha evidence.
- **Event** - a successful command appends a `support.EvidenceAccepted` event.
- **Actor** - the Launch Support evidence aggregate applies events in order.
- **Event store** - support evidence events are appended to the platform event store as durable
  source of truth.
- **Materialized view / projection** - a projection folds evidence events into the
  support-readiness status read model.
- **Snapshot** - the accepted HOBO-460 evidence record is the snapshot of that projection.
- **Read store** - release cutline, beta feedback, and support-readiness surfaces query that read
  store rather than raw events.

No runtime engine, projector, support tool, or event store is implemented here; this is a design-time
contract that names the command, event, actor, and projection boundaries so later implementation
inherits a consistent vocabulary.
