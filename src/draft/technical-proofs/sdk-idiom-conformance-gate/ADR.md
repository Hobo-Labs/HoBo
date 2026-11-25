# Sdk Idiom Conformance Gate — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and
how its records map onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package's boundary.
- The required-lanes record includes the HOBO-517 resilience-semantics lane so
  retry, deadline, cancellation, lifecycle, and inspection helper claims cannot
  pass on golden-IR equality alone.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted input is
parsed once at the boundary into derived domain types, and downstream consumers
receive those parsed, derived types instead of re-checking raw input. The CUE
constraints bound the same derived types so malformed input is rejected at parse
time rather than passed downstream.

## Event Architecture

The package's accepted record is the read model behind a small event flow:

- **Command** — a request to record or change the package's accepted state.
- **Event** — a successful command appends a domain event to the log.
- **Actor** — the owning aggregate is the actor that applies events in order.
- **Event store** — accepted events are appended to the platform event store as
  the durable source of truth.
- **Materialized view / projection** — a projection folds the event store into
  the read model consumers query.
- **Snapshot** — the accepted record is the snapshot of that projection.
- **Read store** — downstream surfaces query that read store rather than the raw
  event log.
- **Conformance lanes** — the projection exposes golden-IR, existing semantics,
  resilience semantics, thin-layer, authorship, and coverage lane snapshots
  separately so one passing lane cannot mask another failure.

No runtime engine, projector, or event store is implemented here; this is a
design-time contract that names the command, event, actor, and projection
boundaries so later implementation inherits a consistent vocabulary.
