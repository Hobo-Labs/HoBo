# Beta Pilot Release Candidate Evidence - Architecture Evidence

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

- **Command** - `betaPilotReleaseCandidateEvidence.RecordRequested` asks the beta pilot owner
  aggregate to record or amend the release-candidate gate.
- **Event** - `betaPilotReleaseCandidateEvidence.RecordAccepted` appends the parsed evidence
  record, blocker ledger, accepted risks, cutline dependency mapping, and follow-up ledger.
- **Actor** - the V1 Beta Pilot & Feedback Loop proof owner is the aggregate that applies accepted
  evidence events in order.
- **Event store** - accepted events are appended to the platform event store as the durable source
  of truth.
- **Materialized view / projection** - a projection folds accepted events into the current M3
  evidence-gate read model.
- **Snapshot** - the current accepted release-candidate gate is the projection snapshot used by
  release cutline, support, documentation, and GA handoff review.
- **Read store** - downstream release and support surfaces query the read store rather than raw
  Linear comments, customer notes, or ad hoc checklists.

No beta customer onboarding, feedback portal, product UX, support tooling, runtime engine,
projector, or hosted operation is implemented here. This is a design-time contract that names the
command, event, actor, event-store, projection, snapshot, and read-store boundaries for later
implementation.
