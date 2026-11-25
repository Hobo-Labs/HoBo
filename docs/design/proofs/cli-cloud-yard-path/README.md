---
type: Reference
title: "CLI Cloud Yard Path Proof Note"
description: "HOBO-625 acceptance evidence for the CLI cloud command path proof."
tags: [hobo, design, proof]
---

# CLI Cloud Yard Path Proof Note

HOBO-625 proves the CLI cloud command path as an independent experience proof. Source package:
[`src/draft/exp-proofs/dx/cli-cloud-yard-path`](../../../../src/draft/exp-proofs/dx/cli-cloud-yard-path/README.md).

## Acceptance Mapping

- **Cloud commands through Gateway:** `hobo login`, `hobo plan`, `hobo deploy`, `hobo destroy`,
  `hobo inspect deploy`, and `hobo logs` exercise mocked Gateway routes pinned by
  `architecture/pacts/cli_cloud_yard_path.pact.json`.
- **J1 journey:** `runJ1HelloBindleJourney` runs `hobo plan` → `hobo deploy` → `hobo inspect deploy`
  for `examples/hello-bindle` using fixture `dx.lifecycle.hello-bindle.v1`.
- **NFR-017 actionable errors:** gatekeeper denial and stale projection failures include root cause,
  two remediation steps, and correlation ids (`validateActionableError`).
- **Adversarial guards:** unauthenticated plan, gatekeeper-blocked deploy, stale inspect, and scope
  creep into production CLI/live Yard are rejected.

## Verification

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\cli-cloud-yard-path test
```

## Scope Out

This proof does not implement production `packages/cli`, merged `packages/cloud`, or Gatekeeper
engines from HOBO-624. It promotes deploy-path flows from
`src/draft/epic-proofs/cli-mcp-developer-experience/` as an isolated draft POC awaiting blocker
merge.

## Maintenance

Docs freshness: added with HOBO-625 draft POC (cursor/hobo-625-hobo-agent-workflow-451f).
