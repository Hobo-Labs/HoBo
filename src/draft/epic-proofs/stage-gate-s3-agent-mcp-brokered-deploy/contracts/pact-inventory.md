# Stage Gate S3 Pact Inventory

| Contract | Consumer | Provider | Scenario |
|---|---|---|---|
| `j2-mcp-journey.pact.json` | stage-gate-j2-agent | hobo-mcp-s2-sandbox | list_templates + NFR-017 deploy gate |
| `brokered-token-audit.pact.json` | stage-gate-j2-agent | hobo-token-broker | in-ceiling grant + over-ceiling deny |
| `agent-guardrail-gate.pact.json` | stage-gate-j2-agent | hobo-mcp-security-gateway | prod deploy approval |
| `credential-audit-retention.pact.json` | stage-gate-ci-drill | hobo-credential-audit-projection | replayable brokered trail, no static secrets |

All interactions are exercised by `runStageGateS3Drill()` and verified in `contracts/consumer/stage-gate-boundaries.test.ts`.
