# Tenant Data Lifecycle Contract - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its TypeScript record is parsed and how its
records map
onto the platform event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted tenant data lifecycle input
is parsed once at the boundary into derived domain types. Downstream consumers receive parsed
domain types for data class id, deletion/export obligation state, retention class, residency
sensitivity, and owner route instead of re-checking raw strings.

## Event Architecture

The package's accepted record is the read model behind a small event flow:

- **Command** - `TenantDataLifecycleScopeCommand` requests recording or changing the accepted state.
- **Event** - `TenantDataLifecycleScopeAccepted` or `TenantDataLifecycleScopeDenied` is appended.
- **Actor** - the Compliance Evidence Pack actor applies lifecycle-scope events in order.
- **Event store** - accepted events are appended to the compliance event store as durable truth.
- **Materialized view / projection** - projections fold the event store into customer-assurance,
  privacy, support, and security review views.
- **Snapshot** - beta/GA launch snapshots preserve the accepted lifecycle state.
- **Read store** - downstream surfaces query read stores rather than raw event logs.

No runtime workflow, projector, storage backend, or event store is implemented here; this is a
design-time contract that names command, event, actor, projection, snapshot, and read-store
boundaries for later implementation.
