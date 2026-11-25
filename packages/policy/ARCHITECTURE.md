# @hobo/policy — Architecture Evidence

Production policy plane for HOBO-633 (S3-07). Promotes the agent guardrails
contract from `src/draft/technical-proofs/s3-07-agent-guardrails-contract/` into
`packages/policy/` with the built-in TypeScript policy IR and agent guardrail
engine (FR-022, BR-011).

## Schema and constraints

- Protobuf records live in [`data-models/`](./data-models).
- CUE constraints bound every protobuf type in those schemas.
- PACT consumer evidence for the Gateway/runtime guardrail boundary lives under
  [`contracts/`](./contracts).

## Parse, don't validate

`parseDecisionRequest`, `parseAgentGuardrailPolicy`, and `parseDecision` are the
single parse-don't-validate boundaries: untrusted policy input becomes derived
parsed domain types before guardrail evaluation runs. Gateway and runtime callers
receive parsed decisions and obligations instead of re-checking raw DTO fields.

## Event architecture

- **Command** — an agent action request at Gateway or runtime enforcement point.
- **Event** — `policy.Decided`, `agent.GuardrailBlocked`, `agent.GuardrailCleared`,
  `agent.DestroyDenied`, `spend.CapGateEvaluated`, and `policy.ObligationSatisfied`.
- **Actor** — the agent guardrail aggregate applies events in order.
- **Event store** — accepted events append to the platform event store as the
  durable source of truth.
- **Materialized view / projection** — `rebuildAgentGuardrailState` folds the
  event store into blocked/cleared state.
- **Snapshot** — the rebuilt guardrail state is the snapshot of that projection.
- **Read store** — `canAgentProceed` queries that snapshot rather than the raw
  event log.
