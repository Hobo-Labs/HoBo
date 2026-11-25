# S3-07 Agent Guardrails Contract — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how agent guardrail
decisions are parsed and how obligations map onto the platform event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package's boundary.

## Parse, Don't Validate

This package applies the **parse, don't validate** discipline: untrusted policy
input is parsed once at the boundary into derived domain types such as
`parseAgentGuardrailPolicy` and `createDecisionRequest`. Gateway and runtime
callers receive parsed decisions and obligations instead of re-checking raw DTO
fields.

## Event Architecture

The package's guardrail state is the read model behind a small event flow:

- **Command** — an agent action request at Gateway or runtime enforcement point.
- **Event** — `policy.Decided`, `agent.GuardrailBlocked`, `agent.GuardrailCleared`,
  `agent.DestroyDenied`, `spend.CapGateEvaluated`, and
  `policy.ObligationSatisfied`.
- **Actor** — the agent guardrail aggregate applies events in order.
- **Event store** — accepted events append to the platform event store as the
  durable source of truth.
- **Materialized view / projection** — `rebuildAgentGuardrailState` folds the
  event store into blocked/cleared state.
- **Snapshot** — the rebuilt guardrail state is the snapshot of that projection.
- **Read store** — `canAgentProceed` queries that snapshot rather than the raw
  event log.

No runtime engine is implemented here; this is a design-time contract naming the
seams production `packages/policy/` must preserve.
