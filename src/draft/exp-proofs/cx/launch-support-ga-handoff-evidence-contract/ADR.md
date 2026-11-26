# Launch Support GA Handoff Evidence - Architecture Evidence

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
`parseLaunchSupportGaHandoffEvidence`: raw GA launch support evidence crosses
one boundary and becomes an immutable branded domain record with owner mappings,
blocker records, accepted-risk records, release-cutline dependencies, follow-up
boundaries, parent readiness sync, and public-claim guards already constrained,
or it fails closed. Downstream release, support, incident-communication,
security, operations, and launch-communications consumers receive that parsed
type rather than repeatedly checking raw DTO strings.

## Event Architecture

The accepted M4 evidence record is the read model behind a small event flow:

- **Command** - `launchSupportGaHandoffEvidence.RecordRequested` asks the launch
  support owner aggregate to record or amend GA handoff evidence.
- **Event** - `launchSupportGaHandoffEvidence.RecordAccepted` appends the parsed
  evidence record, blocker ledger, accepted risks, release-cutline dependency
  mapping, follow-up ledger, parent readiness sync, and public-claim guard state.
- **Actor** - the V1 Launch Support Desk & Escalation proof owner is the
  aggregate that applies accepted evidence events in order.
- **Event store** - accepted events are appended to the platform event store as
  the durable source of truth.
- **Materialized view / projection** - a projection folds accepted events into
  the current M4 launch support GA handoff read model.
- **Snapshot** - the current accepted GA handoff gate is the projection snapshot
  used by release cutline, support workflow, incident communications, security,
  and public launch review.
- **Read store** - downstream release and support surfaces query the read store
  rather than raw Linear comments, support tickets, or ad hoc checklists.

No support runtime, helpdesk software, ticket queue, on-call scheduler,
status-page publisher, customer-data access path, runtime engine, projector, or
hosted operation is implemented here. This is a design-time contract that names
the command, event, actor, event-store, projection, snapshot, and read-store
boundaries for later implementation.
