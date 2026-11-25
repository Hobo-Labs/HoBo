---
type: Reference
title: "HOBO-427 Audit Explorer M0 Scope Proof"
description: "Source issue: HOBO-427."
tags: [hobo, design]
---

# HOBO-427 Audit Explorer M0 Scope Proof

HOBO-427 is proven by the focused M0 contract at
[`src/draft/exp-proofs/ux/audit-explorer-scope-contract`](../../../../src/draft/exp-proofs/ux/audit-explorer-scope-contract/README.md)
and the durable scope record at [audit-explorer.md](../../audit-explorer.md).

## Acceptance Evidence

- Goal and personas are explicit for security/compliance reviewers, support operators, workspace
  admins, platform engineers, and governance leads.
- Scope in, scope out, non-goals, and service/UX/security/support boundaries are recorded.
- Dependencies map to Plan 07, Plan 49, Plan 11, Plan 29, Plan 06, Plan 46, ADR-0046, ADR-0074,
  ADR-0077, and ADR-0050.
- Owning initiative dependencies map Audit Explorer, Admin Console, Support Workflow, Security
  Verification, Governance/Compliance Evidence, Data Plane, CLI/MCP & Developer Experience, and
  Identity/Auth without taking their implementation scope.
- Audit fact classes, tenant-first query filter axes, and redacted export evidence are named with
  owners and proof expectations.
- M1 evidence is listed as audit fact class register, query filter contract, redaction fixture,
  export manifest, support handoff context, replay reconstruction fixture, and follow-up issue gate.
- Follow-up M1-M4 issues are blocked until M0 acceptance is recorded.

## Negative Coverage

- Scope validation rejects UI implementation, event-store runtime, search indexing, SIEM/export
  service, RBAC enforcement, support workflow, credential exposure, or live customer-data creep.
- Request routing keeps Admin Console, Support Workflow, Security Verification, Data Plane,
  Governance/Compliance Evidence, CLI/MCP, and Identity/Auth decisions with their owning
  initiatives.
- Follow-up gating refuses M1-M4 issue creation while M0 is not accepted.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\audit-explorer-scope-contract test
npm.cmd --prefix src\draft\exp-proofs\audit-explorer-scope-contract run typecheck
```
