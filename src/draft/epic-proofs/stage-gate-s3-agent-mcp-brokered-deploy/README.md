# Stage Gate S3: Agent MCP Brokered Deploy

Epic reference implementation for **HOBO-636** — closes Stage 3 gate as a CI-runnable J2 drill where an MCP agent deploys `examples/hello-bindle` on the S2 sandbox using only brokered short-lived tokens.

## Vertical slice

```gherkin
Feature: Agent deploys via MCP with brokered tokens only

  Persona: Atlas — AI agent (co-primary ICP)

  Scenario: J2 journey against hello-bindle on S2 cloud
    Given an SVID-bound MCP session scoped by .allow()
    When the agent runs list_templates → new → plan → request_token → deploy → inspect_run/tail_logs
    Then only brokered short-lived tokens appear in the trace
    And token.Granted and token.Used events are present and replayable
    And an NFR-017 deploy failure self-corrects via machine-readable remediation
    And a high-risk prod deploy blocks until a human approves
    And request_token outside the .allow() ceiling is refused
```

## Running the drill

```bash
pnpm --prefix src/draft/epic-proofs/stage-gate-s3-agent-mcp-brokered-deploy test
pnpm --prefix src/draft/epic-proofs/stage-gate-s3-agent-mcp-brokered-deploy run simulate
```

## What this proves

- J2 MCP tool sequence against `examples/hello-bindle` on `s2-sandbox` (mocked S2 cloud).
- Brokered token path via `request_token` bounded by `.allow()` declarations.
- `token.*` audit trail with replay digest over the event store.
- NFR-017 `explainFailure` remediation drives verify → redeploy self-correction.
- Agent guardrails: prod deploy requires approval; static cloud keys rejected.
- The validated MCP server hardening proof is included in this drill; its deterministic simulation contract is unchanged.
- The validated auth.json proof is absorbed without changing broker-only token issuance or approval-gate behavior.
- Zero static secrets in the successful drill trace.

## Mocked boundaries

| Boundary | Mock strategy | Contract |
|---|---|---|
| MCP J2 journey | SVID-bound in-process MCP server + fixture handlers | `j2-mcp-journey.pact.json` |
| Token broker | OIDC federation stub, in-memory event sink | `brokered-token-audit.pact.json` |
| Agent guardrails | `createMcpSecurityGateway` approval hooks | `agent-guardrail-gate.pact.json` |
| Credential audit | Event-store replay + static-secret scan | `credential-audit-retention.pact.json` |

## Scope

**In:** deterministic J2 drill, adversarial guards, architecture evidence (protobuf/CUE/Pact).

**Out:** production `packages/mcp/`, live S2 cloud, credentialed CI lane wiring (S3-01 acceptance record attachment).

## Architecture evidence

- `architecture/` — protobuf + CUE for drill records.
- `architecture.md` — parse-don't-validate and event-architecture notes.
- `contracts/pact-inventory.md` — boundary inventory.

## Cascade reconciliation (83d9b5c92)

The `token-broker-skeleton-contract` technical proof refresh is absorbed without changing staged brokered-deploy evidence.
