# Dogfood Yard Private Beta Evidence Contract - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its TypeScript record is parsed and how its
records map onto the platform event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted private beta evidence is
parsed once at the boundary into derived domain types. Downstream consumers receive parsed types for
scenario id, evidence channel id, owner, status, blocker, accepted risk, dependency, missing
evidence, follow-up issue, and parent-sync state instead of re-checking raw strings.

## Event Architecture

The package's accepted record is the read model behind a small event flow:

- **Command** - `DogfoodPrivateBetaEvidenceCommand` requests recording or changing private beta
  evidence.
- **Event** - `DogfoodPrivateBetaEvidenceAccepted` or `DogfoodPrivateBetaEvidenceDenied` is
  appended.
- **Actor** - the Dogfood readiness actor applies evidence events in order.
- **Event store** - accepted events are appended to the release-readiness event store as durable
  truth.
- **Materialized view / projection** - projections fold the event store into release-cutline,
  support-handoff, and beta-readiness review views.
- **Snapshot** - private beta snapshots preserve accepted scenario/channel/blocker/risk/follow-up
  state.
- **Read store** - release and support surfaces query read stores rather than raw event logs.

No runtime workflow, hosted Yard service, provider adapter, admin UI, support automation, bootstrap
installer, projector, storage backend, or event store is implemented here; this is a design-time
contract that names command, event, actor, projection, snapshot, and read-store boundaries for later
implementation.
