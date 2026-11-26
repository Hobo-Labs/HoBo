# Launch Site Demo Alpha Evidence - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, Don't Validate

This package follows **parse, don't validate**: untrusted launch evidence input is parsed once at the
boundary into a derived alpha-evidence record. Downstream consumers receive the parsed record with
owner mappings, cutline dependencies, follow-up rules, and public-claim guards already constrained
instead of repeatedly checking broad DTO strings.
Those parsed domain types are the only values passed beyond the package boundary.

## Event Architecture

The accepted M1 evidence record is the read model behind a small event flow:

- **Command** - `launchSiteDemoAlphaEvidence.RecordRequested` asks the launch messaging owner
  aggregate to record or amend the dogfood/alpha evidence gate.
- **Event** - `launchSiteDemoAlphaEvidence.RecordAccepted` appends the parsed evidence record,
  blocker ledger, accepted risks, and cutline dependency mapping.
- **Actor** - the V1 Launch Site, Messaging & Demo Assets proof owner is the aggregate that applies
  accepted evidence events in order.
- **Event store** - accepted events are appended to the platform event store as the durable source
  of truth.
- **Materialized view / projection** - a projection folds accepted events into the current M1
  evidence-gate read model.
- **Snapshot** - the current accepted alpha-evidence gate is the projection snapshot used by launch
  messaging, demo maintainers, and release cutline review.
- **Read store** - downstream release and support surfaces query the read store rather than raw
  Linear comments, launch copy, or ad hoc checklists.

No launch site, live recording service, public copy, runtime engine, projector, or hosted operation
is implemented here. This is a design-time contract that names the command, event, actor,
event-store, projection, snapshot, and read-store boundaries for later implementation.
