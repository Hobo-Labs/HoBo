# Legal Privacy GA Handoff Evidence - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and
how its records map onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline through
`validateLegalPrivacyGaHandoffEvidence`: raw GA legal/privacy evidence crosses
one boundary and becomes a derived domain record with owner mappings, blocker
records, accepted-risk records, release-cutline dependencies, follow-up
boundaries, parent readiness sync, and public-claim guards already constrained,
or it fails closed. Downstream release, legal/privacy, customer-assurance,
security, compliance, and launch-communications consumers receive those parsed
types rather than repeatedly checking raw DTO strings.

## Event Architecture

The accepted M4 evidence record is the read model behind a small event flow:

- **Command** - `legalPrivacyGaHandoffEvidence.RecordRequested` asks the legal
  readiness owner aggregate to record or amend GA handoff evidence.
- **Event** - `legalPrivacyGaHandoffEvidence.RecordAccepted` appends the parsed
  evidence record, blocker ledger, accepted risks, release-cutline dependency
  mapping, follow-up ledger, parent readiness sync, and public-claim guard state.
- **Actor** - the V1 Legal, Privacy & Terms Readiness proof owner is the
  aggregate that applies accepted evidence events in order.
- **Event store** - accepted events are appended to the platform event store as
  the durable source of truth.
- **Materialized view / projection** - a projection folds accepted events into
  the current M4 legal/privacy GA handoff read model.
- **Snapshot** - the current accepted GA handoff gate is the projection snapshot
  used by release cutline, launch communications, customer assurance, security,
  and compliance review.
- **Read store** - downstream release and legal/privacy surfaces query the read
  store rather than raw Linear comments, legal drafts, or ad hoc checklists.

No legal workflow, contract lifecycle system, billing system, paid-launch
mechanics, runtime engine, projector, or hosted operation is implemented here.
This is a design-time contract that names the command, event, actor,
event-store, projection, snapshot, and read-store boundaries for later
implementation.
