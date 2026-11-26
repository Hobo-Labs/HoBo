# Stub Implementation Generation Contract — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package's boundary.

## Parse, Don't Validate

Untrusted stub recordings and generation request material cross
`parseStubRecordings()` and `validateGenRequest()` once. Downstream stages
receive derived domain types (parsed stub bundle, authoritative contract) rather
than re-checking raw DTO fields.

## Event Architecture

- **Command** — `hobo.gen.request/v1` to generate an implementation from stub recordings.
- **Event** — `gen.CandidateGenerated`, `gen.ValidationFailed`, `gen.Repaired`, `gen.Validated`, `impl.Promoted`.
- **Actor** — generation repair loop actor applies validation outcomes in order.
- **Event store** — repair events append to the generation stream as durable evidence.
- **Materialized view** — promotion record is the read model after convergence.
- **Snapshot** — final validation report and promotion gate decision.
- **Read store** — CI and sandbox validators query the validation report snapshot.

No runtime engine is implemented here; this is a design-time contract naming the
command, event, actor, and projection boundaries.
