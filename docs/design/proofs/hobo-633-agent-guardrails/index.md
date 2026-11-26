# HOBO-633 Agent Guardrails Proof

Branch evidence for S3-07 agent guardrails (FR-022, BR-011) in
[Plan 06](../../ai-native-agent-auth.md#plan-06) and
[Plan 29](../../contracts-policy-flags.md#plan-29).

## Acceptance Evidence

- `packages/policy/` production implementation blocks high-risk deploy actions on
  a policy gate until human approval, emitting replayable `policy.Decided` and
  `agent.GuardrailBlocked` events.
- Spend-over-cap deploy halts with `require-approval` and
  `spend.CapGateEvaluated` instead of silent spend.
- Destroy without an explicit grant is denied with `agent.DestroyDenied` and a
  `policy.Decided` deny effect.
- Forged approval obligations do not release unrelated blocked actions.
- Draft source retained at
  `src/draft/technical-proofs/s3-07-agent-guardrails-contract/` for contract
  traceability.

## Scope Boundary

Production `@hobo/policy` ships the guardrail engine. Live Gateway middleware
wiring and durable `agent()` step execution remain integration follow-ups.

## Verification

```sh
pnpm --filter @hobo/policy test
pnpm --filter @hobo/policy test:contract:consumer
pnpm agent:check -- --staged
```
