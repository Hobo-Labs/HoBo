---
type: Design Proof Evidence
title: "HOBO-564 Vibe Support Case Redacted Evidence Proof"
description: "M2 proof record for support case prototype redacted evidence packs."
tags: [hobo, proof, support, redaction, vibe]
timestamp: 2026-07-01T00:00:00Z
---

# HOBO-564 Vibe Support Case Redacted Evidence Proof

This proof records branch evidence for the support case reference prototype with
redacted evidence packs, deterministic triage, owner route, customer update, and
closure examples.

## Evidence

- Source record: [`support-workflow.md`](../../support-workflow.md).
- Support SLA source: [`support-sla-channels.md`](../../support-sla-channels.md).
- Incident handoff source: [`incident-communications.md`](../../incident-communications.md).
- Upstream support mockups: [`vibe-support-workflow-mockups`](../vibe-support-workflow-mockups/README.md).
- Quickstart source consumed by the upstream support workflow proof:
  [`resource-lifecycle-quickstart-examples`](../resource-lifecycle-quickstart-examples/README.md).
- Executable proof:
  [`vibe-support-case-redacted-evidence`](../../../../src/draft/exp-proofs/ux/vibe-support-case-redacted-evidence/README.md).

## Acceptance Coverage

| Acceptance | Proof |
|---|---|
| Prototype consumes the M1 support intake, triage, owner-route, and customer update mockups. | `consumedSupportWorkflowMockupRefs` pins every accepted HOBO-550 mockup id and proof path. |
| Evidence pack examples include redacted logs, incident/support references, admin context, docs source, proof package link, redaction state, and next update condition. | `evidencePacks` carry those fields and the parser rejects missing evidence metadata. |
| Package and proof path match the issue. | `parseVibeSupportCaseRedactedEvidence` rejects path drift from the target package and proof path. |
| Happy path, blocked path, stale/unknown evidence path, support handoff, accessibility notes, and proof-mode labels are covered. | `scenarioPaths`, `accessibilityNotes`, and proof-mode validation cover each acceptance state and label. |
| Support case evidence stays customer-safe and scope-bound. | `classifySupportCasePrototypeRequest` rejects helpdesk integration, support queue automation, customer-data access, incident command, on-call staffing, production UI, contractual SLA promises, and commercial support creep. |

## Adversarial Evidence

The parser and tests reject requests that try to turn this proof into helpdesk
integration, support queues, customer-data access, incident command, on-call
staffing, production support UI, contractual SLA promises, paid support terms,
or proofless launch claims.

## Verification

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\vibe-support-case-redacted-evidence test
```
