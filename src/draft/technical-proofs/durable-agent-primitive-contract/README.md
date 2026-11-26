# HoBo Durable Agent Primitive POC

This draft package proves the HOBO-632 / FR-021 durable `agent()` primitive for
[Plan 6](../../../../docs/design/ai-native-agent-auth.md#plan-06):

- `agent(name, { model, instructions, tools, run })` defines a durable agent.
- Every `ctx.tool(...)` call executes as a recorded durable step.
- `ctx.identity` exposes the attested SVID issued at run start.
- `ctx.token(provider, scope)` delegates to the HOBO-84 token broker skeleton.
- Agent runs replay from cached tool and token steps with `replayEqualsLive`.

## Contract Surface

- Tool calls emit `agent.tool.step.requested` and `agent.tool.step.completed`.
- Run lifecycle emits `agent.run.started` and `agent.run.completed`.
- Identity issuance uses `identity.Issued`; token brokering emits `token.*` audit events.
- Replay re-executes the agent handler but reuses cached tool/token step results.

## Proof Boundaries

This proof does not implement production `packages/runtime/`, real LLM calls,
guardrails, spend caps, or the S1-12 replay engine service. It promotes the
durable-agent shape as an independent draft POC that composes existing identity
and token-broker proofs.

## Executable Checks

```bash
pnpm --prefix src/draft/technical-proofs/durable-agent-primitive-contract test
pnpm --prefix src/draft/technical-proofs/durable-agent-primitive-contract run example
```

The checks prove tools-as-steps, `ctx.identity`, `ctx.token` event emission,
`replayEqualsLive`, out-of-SVID-scope token denial, and replay divergence
detection.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
