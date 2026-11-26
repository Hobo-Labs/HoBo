---
type: Reference
title: "HOBO-664 S6-09 operator crew Yard services proof"
description: "Design proof record for the S6-09 operator crew Yard services draft contract (HOBO-664)."
tags: [hobo, design, proof]
---

# HOBO-664 — S6-09 operator crew Yard services proof

Source issue: [HOBO-664](https://linear.app/quickdeploy-ai/issue/HOBO-664).

Executable proof:
[`s6-09-operator-crew-yard-services-contract`](../../../../src/draft/technical-proofs/s6-09-operator-crew-yard-services-contract/README.md).

Design authority: [operators-sre.md § Plan 40](../../operators-sre.md#plan-40).

## Acceptance mapping

| Acceptance criterion | Evidence |
| --- | --- |
| Simulated SLO breach dispatches SRE operator | `test/operator-crew-yard-services.test.ts` — "dispatches the SRE operator when endpoint monitor reports an SLO breach" |
| Low-risk fix auto-canaries + auto-rolls-back | same file — "auto-canaries a low-risk fix and auto-rolls back on regression" |
| Prod fix blocks on approval | same file — "blocks a production remediation until human approval" |
| Every Crew action audited in credential/agent-activity views | same file — "records every crew action in credential and agent-activity audit views" |
| AI governance blocks flagged output (adversarial) | same file — "blocks flagged model output through the AI governance sandbox" |
| GitOps RBAC denial without deployer role (adversarial) | same file — "denies GitOps promote when the operator lacks the deployer role" |
| GitOps promote success with deployer role | same file — "promotes through GitOps when deployer role and can-deploy are green" |
| Platform Engineer prod approval gate | same file — "blocks platform-engineer definition proposals in prod until approval" |
| Platform Engineer staging autonomous propose | same file — "allows platform-engineer definition proposals in staging without approval" |

Reviewer maintenance note: independent draft POC; does not import unmerged
S6-03/S6-08 production code. Promotes
[`operators-sre-crew`](../../../../src/draft/epic-proofs/operators-sre-crew/README.md)
scenarios onto the Yard-service principal model.
