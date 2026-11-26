# V1 Release Notes Upgrade Guide Release Candidate Evidence - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and how its records map
onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline through
`assertReleaseNotesReleaseCandidateEvidence`: raw release-candidate release-note evidence crosses
one boundary and becomes a derived domain record with owner mappings, blocker records,
accepted-risk records, release-cutline dependencies, missing-evidence follow-ups, parent readiness
sync, and public-claim guards already constrained, or it fails closed. Downstream release, docs,
bootstrap, compatibility, support, and cutline consumers receive those parsed types rather than
repeatedly checking raw DTO strings.

## Event Architecture

The accepted M3 evidence record is the read model behind a small event flow:

- **Command** - `releaseNotesReleaseCandidateEvidence.RecordRequested` asks the release-notes owner
  aggregate to record or amend release-candidate evidence.
- **Event** - `releaseNotesReleaseCandidateEvidence.RecordAccepted` appends the parsed evidence
  record, blocker ledger, accepted risks, release-cutline dependency mapping, follow-up ledger, and
  public-claim guard state.
- **Actor** - the V1 Release Notes & Upgrade Guide proof owner is the aggregate that applies
  accepted evidence events in order.
- **Event store** - accepted events are appended to the platform event store as the durable source
  of truth.
- **Materialized view / projection** - a projection folds accepted events into the current M3
  evidence-gate read model.
- **Snapshot** - the current accepted release-candidate release-note gate is the projection snapshot
  used by release cutline, docs, bootstrap, compatibility, support, and GA handoff review.
- **Read store** - downstream release and documentation surfaces query the read store rather than
  raw Linear comments, ad hoc checklists, or draft customer copy.

No docs portal publisher, release automation, customer email, upgrade engine, compatibility
harness, support workflow, runtime launch gate, projector, or hosted operation is implemented here.
This is a design-time contract that names the command, event, actor, event-store, projection,
snapshot, and read-store boundaries for later implementation.
