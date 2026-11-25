# Launch Site Release Candidate Evidence - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, Don't Validate

This package follows **parse, don't validate**: untrusted release-candidate evidence input is parsed
once at the boundary into a derived M3 evidence record. Downstream consumers receive the parsed
record as parsed domain types with owner mappings, blockers, accepted risks, cutline dependencies,
follow-up rules, and public-claim guards already constrained instead of repeatedly checking broad
DTO strings.

## Event Architecture

The accepted M3 evidence record is the read model behind a small event flow:

- **Command** - `launchSiteReleaseCandidateEvidence.RecordRequested` asks the launch-site owner
  aggregate to record or amend the release-candidate gate.
- **Event** - `launchSiteReleaseCandidateEvidence.RecordAccepted` appends the parsed evidence
  record, blocker ledger, accepted risks, cutline dependency mapping, and follow-up ledger.
- **Actor** - the V1 Launch Site, Messaging & Demo Assets proof owner is the aggregate that applies
  accepted evidence events in order.
- **Event store** - accepted events are appended to the platform event store as the durable source
  of truth.
- **Materialized view / projection** - a projection folds accepted events into the current M3
  evidence-gate read model.
- **Snapshot** - the current accepted release-candidate gate is the projection snapshot used by
  release cutline, launch messaging, support, legal/privacy, documentation, and GA handoff review.
- **Read store** - downstream release and launch surfaces query the read store rather than raw
  Linear comments, ad hoc asset checklists, or marketing copy drafts.

No launch-site implementation, public page, final copy, live recording capture, visual asset
pipeline, release automation, runtime engine, projector, or hosted operation is implemented here.
This is a design-time contract that names the command, event, actor, event-store, projection,
snapshot, and read-store boundaries for later implementation.
