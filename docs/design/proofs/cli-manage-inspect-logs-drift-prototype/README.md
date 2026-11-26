---
type: Reference
title: "CLI Manage Inspect Logs Drift Prototype Proof"
description: "Source issue: HOBO-574."
tags: [hobo, design]
---

# CLI Manage Inspect Logs Drift Prototype Proof

HOBO-574 records the manage transcript prototype that later docs, support,
dashboard, automation, and quickstart artifacts must reuse for inspect, logs,
drift, and support-bundle behavior.

## Evidence

- Proof package:
  [`../../../../src/draft/exp-proofs/dx/cli-manage-inspect-logs-drift-prototype/README.md`](../../../../src/draft/exp-proofs/dx/cli-manage-inspect-logs-drift-prototype/README.md)
- Source designs:
  - [`developer-experience.md#plan-07`](../../developer-experience.md#plan-07)
  - [`data-plane.md#plan-11`](../../data-plane.md#plan-11)
  - [`support-debug-tools.md`](../../support-debug-tools.md)
  - [`drift-reconciliation.md`](../../drift-reconciliation.md)
  - [`audit-explorer.md`](../../audit-explorer.md)
  - [`dx-resource-lifecycle-scenario-matrix`](../../../../src/draft/exp-proofs/dx/dx-resource-lifecycle-scenario-matrix/README.md)
  - [`cli-mcp-parity-resource-lifecycle-contracts`](../../../../src/draft/exp-proofs/ax/cli-mcp-parity-resource-lifecycle-contracts/README.md)

## Acceptance Mapping

- Transcript scenes cover normal operation, stale projection, non-reactive sink
  warning, drift detected, support handoff, and redacted evidence pack.
- Fixture sources cover run inspector, projection freshness, log cursor, drift,
  token/audit, and support evidence.
- Each scene renders human terminal text and machine-readable JSON with status,
  code, remediation, fixture ID, proof mode, correlation ID, and redaction
  evidence.
- CLI transcript intent and MCP tool results are checked for semantic parity.
- Copy names `reference fixture` mode and refuses live-state, live-log,
  customer-data, real-support-tooling, and dashboard-first claims.

## Adversarial Evidence

- Production observability pipelines are refused.
- Live log streaming and real provider access are refused.
- Customer data and unredacted logs are refused.
- Real support tooling and ticket queue automation are refused.
- Dashboard-first run inspector mockups are refused.

## Proof Command

```powershell
pnpm.cmd --dir src\draft\exp-proofs\cli-manage-inspect-logs-drift-prototype test
```

## Scope Boundary

This proof does not implement a production observability pipeline, live log
streaming, real support tooling, customer data flow, or dashboard-first run
inspector mockup.
