# Bootstrap Launch Smoke Matrix Contract - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its TypeScript record is parsed and how its
records map onto the platform event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted bootstrap launch-smoke
input is parsed once at the boundary into derived domain types. Downstream consumers receive parsed
domain types for path id, stage id, fixture id, mocked boundary id, unsupported-state label,
seed/auth evidence, and result-feed target instead of re-checking raw strings.

## Event Architecture

The package's accepted record is the read model behind a small event flow:

- **Command** - `BootstrapLaunchSmokeMatrixCommand` requests recording or changing the accepted
  launch smoke matrix.
- **Event** - `BootstrapLaunchSmokeMatrixAccepted` or `BootstrapLaunchSmokeMatrixDenied` is
  appended.
- **Actor** - the bootstrap readiness actor applies matrix events in order.
- **Event store** - accepted events are appended to the bootstrap readiness event store as durable
  truth.
- **Materialized view / projection** - projections fold the event store into release-notes,
  troubleshooting, and support-handoff review views.
- **Snapshot** - launch snapshots preserve the accepted path/stage/result-feed state.
- **Read store** - release and support surfaces query read stores rather than raw event logs.

No runtime workflow, projector, storage backend, installer, deploy runner, auth provider, cleanup
runner, or event store is implemented here; this is a design-time contract that names command,
event, actor, projection, snapshot, and read-store boundaries for later implementation.
