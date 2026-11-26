# Dogfood Yard Release-Candidate Evidence - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, Don't Validate

This package follows **parse, don't validate**: untrusted release-candidate evidence input is parsed
once at the boundary into parsed domain types, including the derived M3 evidence record. Downstream
consumers receive the parsed record with owner mappings, cutline dependencies, follow-up rules,
initiative sync, and claim guards already constrained instead of repeatedly checking broad DTO
strings.

## Event Architecture

The accepted M3 evidence record is the read model behind a small event flow:

- **Command** - `dogfoodReleaseCandidateEvidence.RecordRequested` asks the hosted operations owner
  aggregate to record or amend the release-candidate evidence gate.
- **Event** - `dogfoodReleaseCandidateEvidence.RecordAccepted` appends the parsed evidence record,
  blocker ledger, accepted risks, follow-up mapping, and cutline dependency mapping.
- **Actor** - the V1 Dogfood Yard & Hosted Operations proof owner is the aggregate that applies
  accepted evidence events in order.
- **Event store** - accepted events are appended to the platform event store as the durable source
  of truth.
- **Materialized view / projection** - a projection folds accepted events into the current M3
  release-candidate evidence-gate read model.
- **Snapshot** - the current accepted release-candidate gate is the projection snapshot used by the
  release cutline, support, reliability, and hosted operations reviewers.
- **Read store** - downstream release and support surfaces query the read store rather than raw
  Linear comments, launch copy, or ad hoc checklists.

No hosted Yard runtime, live provider, support automation, projector, public claim publisher, or
GA handoff is implemented here. This is a design-time contract that names the command, event,
actor, event-store, projection, snapshot, and read-store boundaries for later implementation.
