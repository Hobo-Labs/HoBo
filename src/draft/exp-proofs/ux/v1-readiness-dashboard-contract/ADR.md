# V1 Readiness Dashboard Contract — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and how its records map
onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package's boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted dashboard records are parsed
once at the boundary into derived domain types, and downstream consumers receive those parsed,
derived types instead of re-checking raw field data. The CUE constraints bound the same derived
types so malformed input is rejected at parse time rather than passed downstream.

## Event Architecture

The package's accepted record is the read model behind a small event flow:

- **Command** — a request to record or change the dashboard contract.
- **Event** — a successful command appends a readiness-dashboard contract event to the log.
- **Actor** — the release-readiness aggregate is the actor that applies events in order.
- **Event store** — accepted events are appended to the platform event store as the durable source
  of truth.
- **Materialized view / projection** — a projection folds the event store into the dashboard
  contract read model.
- **Snapshot** — the accepted dashboard contract is the snapshot of that projection.
- **Read store** — downstream release surfaces query that read store rather than the raw event log.

No runtime dashboard, projector, or event store is implemented here; this is a design-time contract
that names the command, event, actor, and projection boundaries so later implementation inherits a
consistent vocabulary.
