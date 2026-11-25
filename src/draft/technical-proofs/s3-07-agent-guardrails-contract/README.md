# S3-07 Agent Guardrails Contract POC

Draft promotion source for HOBO-633 (FR-022, BR-011). Production implementation
lives in `packages/policy/` (`@hobo/policy`). This package pins the Gateway and
agent-runtime guardrail obligations and remains the contract traceability source.

## Contract Surface

- `evaluateAgentGuardrail({ request, policy, meteringView, approval, enforcementPoint })`
  classifies an agent action, applies per-action-class effects
  (`auto-allow` / `require-approval` / `deny`), enforces `spendCapUsd`, and
  requires an explicit destroy grant before destroy actions proceed.
- `rebuildAgentGuardrailState(events)` folds `policy.Decided`, guardrail, and
  obligation facts into replayable state.
- `canAgentProceed(events)` answers whether a blocked action may continue after
  durable approval evidence arrives.

## Proven Behaviors

- High-risk deploy actions block on a policy gate until human approval, with
  `policy.Decided` and `agent.GuardrailBlocked` events at Gateway or runtime.
- Spend-over-cap deploy halts with `require-approval` and `spend.CapGateEvaluated`
  instead of silent spend.
- Destroy without an explicit grant is denied with `agent.DestroyDenied`.
- Forged approval obligations do not release unrelated blocked actions.

## Scope Boundary

Excluded:

- Live Gateway middleware wiring (production engine is `@hobo/policy`).
- Policy pack authoring, NeMo guardrails, or external OPA/Cedar adapters.

## Verification

```sh
npm --prefix src/draft/technical-proofs/s3-07-agent-guardrails-contract test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
