---
type: Reference
title: "CLI Deploy Transcript Prototype Proof"
description: "Source issue: HOBO-573."
tags: [hobo, design]
---

# CLI Deploy Transcript Prototype Proof Note

HOBO-573 proves the terminal-first deploy vibe prototype as an independent experience proof. The
source package is
[`src/draft/exp-proofs/dx/cli-deploy-transcript-prototype`](../../../../src/draft/exp-proofs/dx/cli-deploy-transcript-prototype/README.md).

## Acceptance Mapping

- Successful deploy: `deploy.preview.success` renders `hobo collect`, `hobo plan`, `hobo up`,
  `hobo inspect`, and `hobo logs` over reference fixture ids with Gatekeeper approval and value
  proof wording.
- Blocked deploys: `deploy.blocked.policy-denied`,
  `deploy.blocked.contract-incompatible`, and `deploy.blocked.stale-evidence` render the required
  refusal states with Gatekeeper explanations.
- Fixture coverage: every scenario carries DeploymentPlan, Deployment Set, Delta, Gatekeeper
  decision, ResourceActor event, projection, and log fixture references.
- Human/agent parity: `renderCliTranscript` and `renderMcpToolResult` use the same parsed scenario
  records and fixture ids.
- Guardrails: scope creep into production CLI, live provider apply, real credentials, launch claims,
  or dashboard substitutes is rejected by `rejectDeployTranscriptScopeCreep`.

## Verification

```powershell
pnpm.cmd --dir src\draft\exp-proofs\cli-deploy-transcript-prototype test
```

## Scope Out

This proof does not implement production `hobo up`, provider apply, real auth, customer data,
launch publication, or a visual dashboard. The blocker PRs for HOBO-567 through HOBO-572 remain
separate review artifacts; this package uses reference fixture ids only.
