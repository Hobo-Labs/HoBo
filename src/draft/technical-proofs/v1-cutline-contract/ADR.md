# V1 Cutline Contract — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and
how its records map onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package's boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted input is
parsed once at the boundary into derived domain types, and downstream consumers
receive those parsed, derived types instead of re-checking raw input. The CUE
constraints bound the same derived types so malformed input is rejected at parse
time rather than passed downstream.

## Event Architecture

The package's accepted cutline, M1 dogfood/alpha, M2 private-beta, M3
release-candidate, and M4 GA handoff records are read models behind a small event flow:

- **Command** — `v1CutlineEvidence.RecordRequested` asks the release-program
  owner aggregate to record or change an accepted gate.
- **Event** — `v1CutlineEvidence.RecordAccepted` appends the parsed gate,
  blocker ledger, accepted-risk register, cross-project handoffs, follow-up
  ledger, and public-claim guards.
- **Actor** — the V1 Release Program & Cutline owner aggregate applies evidence
  events in order.
- **Event store** — accepted events are appended to the platform event store as
  the durable source of truth.
- **Materialized view / projection** — a projection folds the event store into
  the current M0/M1/M2/M3/M4 cutline gate read model consumers query.
- **Snapshot** — the accepted record is the snapshot of that projection.
- **Read store** — downstream surfaces query that read store rather than the raw
  event log.

No runtime engine, projector, or event store is implemented here; this is a
design-time contract that names the command, event, actor, and projection
boundaries so later implementation inherits a consistent vocabulary.
