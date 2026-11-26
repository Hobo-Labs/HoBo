# Beta Pilot Dogfood/Alpha Evidence Contract - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and how its records map
onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted input is parsed once at the
boundary into derived domain types, and downstream consumers receive those parsed, derived types
instead of re-checking raw input. The CUE constraints bound the same derived types so malformed
input is rejected at parse time rather than passed downstream.

## Event Architecture

The package's accepted record is the read model behind a small event flow:

- **Command** - a request to record or change the beta dogfood/alpha evidence gate.
- **Event** - a successful command appends an evidence-gate event to the log.
- **Actor** - the beta evidence aggregate is the actor that applies events in order.
- **Event store** - accepted events are appended to the platform event store as the durable source
  of truth.
- **Materialized view / projection** - a projection folds the event store into the evidence matrix,
  blocker/risk register, follow-up policy, and launch-risk delta consumers query.
- **Snapshot** - the accepted gate is the snapshot of that projection.
- **Read store** - release owners query that read store rather than the raw event log.

No runtime engine, projector, or event store is implemented here; this is a design-time contract
that names the command, event, actor, and projection boundaries so later implementation inherits a
consistent vocabulary.
