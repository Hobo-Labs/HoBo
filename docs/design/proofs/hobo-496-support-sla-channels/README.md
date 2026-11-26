---
type: Reference
title: "HOBO-496 Support SLA Channels M0 Proof"
description: "Source issue: HOBO-496."
tags: [hobo, design]
---

# HOBO-496 Support SLA Channels M0 Proof

This proof package demonstrates that HOBO-496 records accepted M0 support SLA and channel coverage
before follow-up Support Workflow design/build work can fan out.

## Evidence

- Design record:
  [`docs/design/support-sla-channels.md`](../../support-sla-channels.md)
- Executable contract:
  [`src/draft/exp-proofs/cx/support-sla-channels-contract`](../../../../src/draft/exp-proofs/cx/support-sla-channels-contract/README.md)
- Traceability row:
  [`docs/design/traceability.md`](../../traceability.md)

## Focused Check

```powershell
npm.cmd --prefix src\draft\exp-proofs\support-sla-channels-contract test
```

The check proves the HOBO-496 acceptance bullets and scope boundaries:

- explicit user/business goal and primary personas;
- recorded scope in/out, non-goals, and service/UX/security/support boundaries;
- support channels, support hours, response targets, severity routing, handoff rules, and
  unsupported request classes;
- separated internal targets, beta promises, and GA customer-facing commitments;
- escalation links across Support Workflow, Incident Communications, Admin Console, and V1 Release
  Program & Cutline;
- follow-up gate preventing M1-M4 issue creation before M0 acceptance;
- rejected scope creep into contractual SLA approval, support tooling, ticket automation, incident
  automation, status-page publication, live customer support operations, or public guarantees.
