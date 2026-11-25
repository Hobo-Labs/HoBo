# Launch Site GA Handoff Evidence - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, Don't Validate

This package follows **parse, don't validate**: untrusted GA handoff evidence input is parsed once at
the boundary into derived domain types for the M4 evidence record. Downstream consumers receive the
parsed record with owner mappings, blockers, accepted risks, release-cutline dependencies, follow-up
rules, initiative sync, and public-claim guards already constrained instead of repeatedly checking
broad DTO strings.

## Event Architecture

The accepted M4 evidence record is the read model behind a small event flow:

- **Command** - `launchSiteGaHandoffEvidence.RecordRequested` asks the launch-site owner aggregate
  to record or amend the GA handoff gate.
- **Event** - `launchSiteGaHandoffEvidence.RecordAccepted` appends the parsed evidence record,
  blocker ledger, accepted risks, cutline dependency mapping, follow-up ledger, and claim guards.
- **Actor** - the V1 Launch Site, Messaging & Demo Assets proof owner is the aggregate that applies
  accepted evidence events in order.
- **Event store** - accepted events are appended to the platform event store as the durable source
  of truth.
- **Materialized view / projection** - a projection folds accepted events into the current M4
  evidence-gate read model.
- **Snapshot** - the current accepted GA handoff gate is the projection snapshot used by release
  cutline, support, documentation, legal/privacy, operations-readiness, and publication review.
- **Read store** - downstream launch surfaces query the read store rather than raw Linear comments,
  ad hoc documents, or local checklists.

No launch-site runtime, public page, final copy, screenshot generation, demo video production, real
cloud provisioning, provider credential use, or production hosting is implemented here. This is a
design-time contract that names the command, event, actor, event-store, projection, snapshot, and
read-store boundaries for later implementation.
