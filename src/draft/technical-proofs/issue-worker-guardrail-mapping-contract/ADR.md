# Issue-Worker Guardrail Mapping Contract — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and
how its records map onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package's boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted automation
doc text is parsed once at the boundary into derived domain types
(`IssueWorkerGuardrailMappingRecord`, `GuardrailMappingRow`), and downstream
consumers receive those parsed, derived types instead of re-checking raw input.
The CUE constraints bound the same derived types so malformed input is rejected
at parse time rather than passed downstream.

## Event Architecture

The package's accepted record is the read model behind a small event flow:

- **Command** — `ValidateIssueWorkerGuardrailMapping`.
- **Event** — `automation.GuardrailMappingAccepted`.
- **Actor** — the automation-spec actor owns the mapping aggregate.
- **Event store** — accepted events are appended to the platform event store as
  the durable source of truth.
- **Materialized view / projection** — a projection folds the event store into
  the guardrail mapping read model.
- **Snapshot** — this proof package and Pact fixture are the current review
  snapshot.
- **Read store** — `docs/automations/hobo-issue-worker.md` consumes the read
  store rather than raw Linear issue text.

No issue-worker runtime, projector, or event store is implemented here; this is a
design-time contract that names the command, event, actor, and projection
boundaries so later implementation inherits a consistent vocabulary.
