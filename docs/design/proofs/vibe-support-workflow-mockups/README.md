---
type: Design Proof Evidence
title: "HOBO-550 Vibe Support Workflow Mockups Proof"
description: "M1 proof record for support intake, triage, owner-route, and customer update mockups."
tags: [hobo, proof, support, mockups, vibe]
timestamp: 2026-07-01T00:00:00Z
---

# HOBO-550 Vibe Support Workflow Mockups Proof

This proof records branch evidence for support intake, severity triage,
evidence linking, owner routing, customer-safe updates, and closure mockups.

## Evidence

- Source record: [`support-workflow.md`](../../support-workflow.md).
- Support SLA source: [`support-sla-channels.md`](../../support-sla-channels.md).
- Incident handoff source: [`incident-communications.md`](../../incident-communications.md).
- Quickstart source: [`resource-lifecycle-quickstart-examples`](../resource-lifecycle-quickstart-examples/README.md).
- Executable proof: [`vibe-support-workflow-mockups`](../../../../src/draft/exp-proofs/ux/vibe-support-workflow-mockups/README.md).

## Acceptance Coverage

| Acceptance | Proof |
|---|---|
| Mockups or wireframes cover support lead, support operator, customer admin, incident commander, release owner, and security/compliance reviewer perspectives. | `test/vibe-support-workflow-mockups.test.ts` asserts every persona has a mockup with a concrete operating question. |
| Fixtures include requester, customer-safe summary, severity, affected surface, owner route, evidence links, redaction state, and next update condition. | `fixtures` carry those fields and the parser rejects missing fixture metadata. |
| Package and proof path match the issue. | `parseVibeSupportWorkflowMockups` rejects path drift from the target package and proof path. |
| Happy path, blocked path, stale/unknown evidence path, support handoff, accessibility notes, and proof-mode labels are covered. | `scenarioPaths`, `accessibilityNotes`, and proof-mode validation cover each acceptance state and label. |
| Support workflow fixtures consume accepted HOBO-577 quickstart fixture ids/proof-mode labels. | `quickstartFixtureRefs` pins `rlq-deploy-run-accepted-v1`, `rlq-manage-stale-evidence-v1`, `rlq-recover-snapshot-restore-v1`, and `rlq-recover-scope-out-v1`. |

## Adversarial Evidence

The parser and tests reject requests that try to turn this proof into helpdesk
software, ticket queue automation, production support UI, customer-data access,
incident command, on-call staffing, contractual SLA promises, or proofless
launch claims.

## Verification

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\vibe-support-workflow-mockups test
```
