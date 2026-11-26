# V1 Beta Pilot Private Beta Evidence - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how private-beta evidence records are parsed
and how they map onto the platform event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted beta evidence input is
parsed once at the boundary into derived domain types for evidence id, owning project, evidence
status, blocker disposition, accepted risk, and parent-readiness signal. Downstream consumers receive
those parsed records instead of re-checking raw strings.

## Event Architecture

The accepted record is the read model behind a small event flow:

- **Command** - `PrivateBetaEvidenceGateCommand` requests recording or changing the accepted gate.
- **Event** - `PrivateBetaEvidenceGateAccepted` or `PrivateBetaEvidenceGateDenied` is appended.
- **Actor** - the Beta Evidence Gate actor applies evidence events in order.
- **Event store** - accepted events are appended to the release-readiness event store as durable
  truth.
- **Materialized view / projection** - projections fold the event store into beta-program,
  cutline, support, docs, UX, and parent release-readiness views.
- **Snapshot** - the M2 private-beta gate snapshot preserves the accepted evidence state.
- **Read store** - downstream surfaces query read stores rather than raw event logs.

No runtime workflow, projector, storage backend, or event store is implemented here; this is a
design-time contract that names command, event, actor, projection, snapshot, and read-store
boundaries for later implementation.
