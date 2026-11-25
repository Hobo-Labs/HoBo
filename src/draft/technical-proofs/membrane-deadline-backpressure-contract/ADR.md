# Membrane Deadline + Backpressure Contract — Architecture Evidence

Draft package for HOBO-598 (S1-09). Carries architecture-guard evidence per
`scripts/check-architecture-guardrails.mjs`.

## Schema And Constraints

- Protobuf data shapes in [`architecture/`](./architecture)
- CUE constraints bound every protobuf type (`expires_at_ms >= started_at_ms`, closed `FailureClass` enum, `in_flight <= max_in_flight` on rejection)
- PACT contract under [`architecture/pacts/`](./architecture/pacts) records caller↔membrane error envelopes

## Parse, Don't Validate

Untrusted input crosses one parser boundary into **derived domain types**:

- `parseDeadline(raw)` → parsed `Deadline` derived type
- `parseFailureClassification(raw)` → parsed `FailureClassification` derived type

Downstream membrane code accepts those parsed derived types only; malformed input is rejected at parse time.

## Event Architecture

Membrane appends append-only link events:

- **Command** — `callImport` / `callProvider` admission request
- **Event** — `link.Established`, `link.Called`, `link.Rejected`, `link.Failed`, `failure.Classified`
- **Actor** — membrane actor enforces deadline/backpressure before trusting provider
- **Event store** — reconciliation dedups EventStore appends via `meta.idempotencyKey`
- **Materialized view** — provider `inFlight`/`callsStarted` counters are projections from events
- **Snapshot** — `report()` is a read-only snapshot of membrane state
- **Read store** — conformance lane queries `report()` and event log

No runtime engine implemented here; design-time contract naming CQRS boundaries for production promotion.
