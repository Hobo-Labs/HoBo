# Token Budget Governance Contract — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and
how its records map onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package's boundary.

## Parse, Don't Validate

Untrusted input is parsed once at the boundary into derived domain types
(`TokenBudget`, `MeteringView` snapshot, estimated token counts). Downstream
consumers receive parsed types; CUE constraints reject malformed input at parse
time.

## Event Architecture

The package's accepted record is the read model behind a small event flow:

- **Command** — pre-inference `evaluateInferenceTokenBudget` request.
- **Event** — `inference.BudgetGateEvaluated`, `policy.Decided`,
  `inference.BudgetContextMissing`.
- **Actor** — the policy-gated inference gate actor applies budget decisions in order.
- **Event store** — accepted events append to the platform event store as the durable
  source of truth.
- **Materialized view / projection** — `MeteringView` folds `meter.UsageRecorded` for
  `inference-tokens-input` / `inference-tokens-output` from OpenInference LLM spans (not
  auth `token.*` grants).
- **Snapshot** — seq-pinned `MeteringView` snapshot is the decision input at gate time.
- **Read store** — downstream showback and spend-breaker surfaces query the projection
  rather than re-reading the raw event log.

No runtime engine, projector, or event store is implemented here; this is a
design-time contract that names the command, event, actor, and projection
boundaries so later implementation inherits a consistent vocabulary.
