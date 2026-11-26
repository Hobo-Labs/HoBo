# Forge Certification Loop Contract — Architecture Evidence

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

The certification loop is the read model behind a small event flow:

- **Command** — certify a Forge candidate inside the no-egress sandbox.
- **Event** — `gen.ValidationFailed`, `gen.Repaired`, `gen.Validated`,
  `gen.SafetyRejected`, `gen.NeedsHuman`, and `gen.Certified` append to the log.
- **Actor** — the Forge certification loop actor applies events in order.
- **Event store** — accepted events are appended as the durable source of truth.
- **Materialized view / projection** — `replayForgeCertificationRun()` folds the
  stream into the generation run read model.
- **Snapshot** — the certified/refused outcome is the snapshot of that projection.
- **Read store** — `replayForgeCertificationRun()` is the read store consumers query
  instead of replaying the raw event log by hand.

No runtime engine, projector, or event store is implemented here; this is a
design-time contract that names the command, event, actor, and projection
boundaries so later implementation inherits a consistent vocabulary.
