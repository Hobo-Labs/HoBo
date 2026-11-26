# Dogfood Yard GA Handoff Evidence - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and
how its records map onto the platform event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline through
`validateDogfoodYardGaHandoffEvidence`: raw Dogfood GA handoff input crosses one
parser boundary and becomes a derived domain record with owner mappings,
predecessor states, blocker records, accepted-risk records, release-cutline
dependencies, follow-up boundaries, parent readiness sync, and public-claim
guards already constrained, or it fails closed. Downstream release, support,
Dogfood, broker, bootstrap, reliability, and documentation consumers receive
that parsed shape instead of repeatedly checking raw DTO strings.

## Event Architecture

The accepted M4 evidence record is the read model behind a small event flow:

- **Command** - `dogfoodYardGaHandoffEvidence.RecordRequested` asks the Dogfood
  Yard release owner aggregate to record or amend GA handoff evidence.
- **Event** - `dogfoodYardGaHandoffEvidence.RecordAccepted` appends the parsed
  evidence set, predecessor gate states, blocker ledger, accepted risks,
  release-cutline dependency mapping, follow-up ledger, parent readiness sync,
  and public-claim guard state.
- **Actor** - the V1 Dogfood Yard & Hosted Operations proof owner is the
  aggregate that applies accepted evidence events in order.
- **Event store** - accepted events are appended to the platform event store as
  the durable source of truth.
- **Materialized view / projection** - a projection folds accepted events into
  the current M4 Dogfood Yard GA handoff read model.
- **Snapshot** - the current accepted GA handoff gate is the projection snapshot
  used by release cutline, release notes, support, bootstrap, reliability,
  broker, and readiness-dashboard consumers.
- **Read store** - downstream release and operations surfaces query the read
  store rather than raw Linear comments, fixture files, or ad hoc checklists.

No Yard runtime, hosted operation, support tool, status-page publisher, release
automation, projector, or event store is implemented here. This is a
design-time contract that names the command, event, actor, event-store,
projection, snapshot, and read-store boundaries for later implementation.
