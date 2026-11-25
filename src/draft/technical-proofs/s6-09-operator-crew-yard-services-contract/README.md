# S6-09 Operator Crew as production Yard services

Draft contract proof for **HOBO-664**. Models the built-in Operator Crew
(SRE, Endpoint Monitor, GitOps, Platform Engineer) as event-sourced Yard
services per [Plan 40](../../../../docs/design/operators-sre.md#plan-40).

Promotes scenarios from
[`operators-sre-crew`](../../epic-proofs/operators-sre-crew/README.md)
without importing unmerged S6-03/S6-08 production code.

## Scope

- **In:** per-agent SVID + policy principals, autonomous reads, policy-gated
  writes, reasoning engine behind a port, AI-governance sandbox, MCP tool
  surface, SLO breach dispatch, low-risk canary + auto-rollback, prod approval
  gate, credential/agent-activity audit trail.
- **Out:** real `packages/sdk` / `packages/agent-skills` runtime, HolmesGPT
  adapter, live deployment sagas, governance-plane enforcement.

## Proof command

```bash
pnpm --prefix src/draft/technical-proofs/s6-09-operator-crew-yard-services-contract test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
