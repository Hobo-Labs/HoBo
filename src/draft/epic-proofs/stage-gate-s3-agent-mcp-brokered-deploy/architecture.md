# Stage Gate S3 Agent MCP Architecture

## Role

HOBO-636 closes the Stage 3 acceptance gate ([requirements.md Stage 3](../../../docs/archive/requirements/requirements.md), OBJ-2). This epic proof composes existing MCP, token-broker, credential-hardening, and agent-guardrail technical proofs into one CI-runnable J2 drill.

## Persona

| Persona | BDD scenario | Proof role |
|---|---|---|
| Atlas — AI agent | J2 MCP deploy with brokered tokens only | Exercises list_templates → new → plan → request_token → deploy → inspect_run/tail_logs against hello-bindle |

## Service boundaries

| Boundary | Consumer | Provider | Mock strategy |
|---|---|---|---|
| J2 MCP journey | Stage-gate drill agent | SVID-bound MCP server | Fixture handlers, no live transport |
| Brokered tokens | MCP `request_token` | Token broker skeleton | OIDC federation stub |
| Agent guardrails | High-risk deploy | MCP security gateway | Approval hooks, spend caps |
| Credential audit | CI drill evidence | In-memory event store | Replay digest, static-secret scan |

## Adversarial decisions

- `request_token` outside `.allow()` ceiling → denied before broker dispatch.
- Static cloud keys → rejected by credential hardening harness.
- Prod deploy → `require-approval` until human with Deployer role satisfies hook.
- Successful drill trace → no static secret patterns (AKIA, sk_live, PEM blocks).

## Guardrail evidence

Parse, don't validate: MCP inputs, token requests, and drill scenario records cross a parser boundary and become **parsed domain types** (`J2ToolCall`, `BrokerTokenRequest`, `ExplainFailure`) before the drill **actor** consumes them. Callers never pass raw DTOs with repeated boolean checks.

Event architecture:

- **Commands:** `DeployBindle`, `RequestBrokerToken`, `ApproveHighRiskDeploy`.
- **Events:** `token.Granted`, `token.Used`, `token.Denied`, `deployment.Succeeded`, `policy.Decided`, `policy.ApprovalSatisfied`.
- **Actor:** `StageGateJ2Agent` issues commands through the MCP seam and reacts to failure events.
- **Event store:** append-only in-memory store captures the brokered-deploy credential trail.
- **Materialized view / projection:** `CredentialAudit` projection rebuilds grant/use timeline from the event stream.
- **Snapshot:** current run timeline for `inspect_run` is a cached snapshot of the deployment projection.
- **Read store:** historical token events remain in the read store for replay digest verification.
