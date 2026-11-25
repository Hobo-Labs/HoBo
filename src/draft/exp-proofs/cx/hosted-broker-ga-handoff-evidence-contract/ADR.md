# Hosted Broker GA Handoff Evidence Contract - Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and how its records map
onto the platform event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted input is parsed once at the
boundary into a derived type. The parsed domain type is `ParsedHostedBrokerGaHandoffEvidence`, and
downstream consumers receive that parsed record instead of raw handoff DTOs plus repeated boolean
checks. The parser rejects missing required evidence, unknown follow-up sources, unsynced
launch-risk changes, proofless GA publication, and manual receipt-edit claims.

## Event Architecture

The accepted handoff record is a read model behind a small event flow:

- **Command** - `hostedBrokerGaHandoff.RecordRequested` asks the broker release owner aggregate to
  record or update an M4 handoff record.
- **Event** - `hostedBrokerGaHandoff.RecordAccepted` appends the parsed owner checklist, Dogfood
  readiness links, version windows, rollback limits, release/support entries, accepted-risk ledger,
  missing-evidence ledger, and public-claim guards.
- **Actor** - the Meta-cloud Broker release owner aggregate applies evidence events in order.
- **Event store** - accepted evidence events are appended to the platform event store as the durable
  source of truth.
- **Materialized view / projection** - a projection folds the event stream into the current hosted
  broker GA handoff read model.
- **Snapshot** - the parsed evidence record is the snapshot consumed by release notes, Dogfood Yard,
  support, and readiness-dashboard consumers.
- **Read store** - downstream surfaces query that read store rather than raw event history.

No runtime engine, broker service, projector, or event store is implemented here; this is a
design-time contract that names the command, event, actor, projection, snapshot, and read-store
boundaries for later implementation.
