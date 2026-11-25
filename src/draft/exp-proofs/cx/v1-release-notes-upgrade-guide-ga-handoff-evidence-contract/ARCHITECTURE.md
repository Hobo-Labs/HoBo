# V1 Release Notes Upgrade Guide GA Handoff Evidence - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and how its records map
onto the platform event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted input is parsed once at the
boundary into a parsed domain type. The derived type is `ParsedReleaseNotesGaHandoffEvidence`,
created by `parseReleaseNotesGaHandoffEvidence`, and downstream release, docs, bootstrap,
compatibility, support, migration, and cutline consumers receive the accepted record instead of raw
handoff DTOs plus repeated boolean checks. The boundary rejects missing owner mappings, unknown blocker
evidence, speculative follow-ups, unsynced launch-risk changes, final-note publication, docs portal
publication implementation, unsupported guarantees, support promises, and broad GA claims.

## Event Architecture

The accepted handoff record is a read model behind a small event flow:

- **Command** - `releaseNotesGaHandoff.RecordRequested` asks the release-note owner aggregate to
  record or update the M4 handoff evidence.
- **Event** - `releaseNotesGaHandoff.RecordAccepted` appends the parsed evidence set, blocker
  ledger, accepted-risk ledger, cutline dependencies, missing-evidence ledger, follow-up boundary,
  parent-readiness sync, and public-claim guards.
- **Actor** - the V1 Release Notes & Upgrade Guide proof owner aggregate applies evidence events in
  order.
- **Event store** - accepted evidence events are appended to the platform event store as the
  durable source of truth.
- **Materialized view / projection** - a projection folds the event stream into the current M4
  release-note GA handoff read model.
- **Snapshot** - the parsed evidence record is the snapshot consumed by release cutline, docs
  portal, bootstrap, compatibility, support, and upgrade consumers.
- **Read store** - downstream surfaces query that read store rather than raw event history.

No runtime engine, docs portal, customer communication workflow, release automation, projector, or
event store is implemented here; this is a design-time contract that names the command, event,
actor, projection, snapshot, and read-store boundaries for later implementation.
