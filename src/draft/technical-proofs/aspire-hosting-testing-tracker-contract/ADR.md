# Aspire.Hosting.Testing Tracker Contract — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`.

## Schema and constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the package boundary.

## Parse, don't validate

Untrusted markdown is parsed once at the boundary into a derived
`AspireHostingTestingTrackerEvaluation`; downstream callers receive that parsed
verdict instead of re-scanning raw tables.

## Event architecture

- **Command** — evaluate tracker parity against design docs.
- **Event** — `tracker.evaluated` records the derived status and reason.
- **Actor** — the tracker evaluator aggregate applies evaluation events in order.
- **Event store** — evaluation events append to the platform log as durable truth.
- **Materialized view / projection** — the evaluation read model consumers query.
- **Snapshot** — `AspireHostingTestingTrackerEvaluation` is the snapshot.
- **Read store** — tests and agents query the evaluation snapshot.

No runtime engine is implemented here; this is a design-time contract naming the
command/event boundaries for later implementation.
