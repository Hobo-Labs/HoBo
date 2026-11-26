# V1 Critical Path Dependency Map Contract — Architecture Evidence

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
dependency domains, blocker types, gate identifiers, owners, or known limitation dispositions are
rejected at parse time rather than passed downstream.

## Event Architecture

The package's accepted record is the read model behind a small event flow:

- **Command** — `CriticalPathDependencyMapCommand` requests an accepted dependency-map record.
- **Event** — a successful command appends `CriticalPathDependencyMapAccepted`; rejected input
  appends `CriticalPathDependencyMapDenied`.
- **Actor** — the release-program aggregate is the actor that applies events in order.
- **Event store** — accepted events are appended to the release event store as the durable source of
  truth.
- **Materialized view / projection** — projections fold the event store into release-readiness and
  launch-dashboard materialized views.
- **Snapshot** — the accepted dependency map is the snapshot of those projections for a release
  phase.
- **Read store** — downstream release, support, security, legal, and operations surfaces query that
  read store rather than raw event logs.

No runtime engine, projector, event store, dashboard, or release go/no-go workflow is implemented
here; this is a design-time contract that names the command, event, actor, and projection
boundaries.
