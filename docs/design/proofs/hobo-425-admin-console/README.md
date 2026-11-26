---
type: Reference
title: "HOBO-425 Admin Console M0 Scope Proof"
description: "Source issue: HOBO-425."
tags: [hobo, design]
---

# HOBO-425 Admin Console M0 Scope Proof

HOBO-425 is proven by the focused M0 contract at
[`src/draft/exp-proofs/ux/admin-console-scope`](../../../../src/draft/exp-proofs/ux/admin-console-scope/README.md)
and the durable scope record at [admin-console.md](../../admin-console.md).

## Acceptance Evidence

- Goal and personas are explicit for workspace admins, project owners, support operators, and
  security/policy admins.
- Scope in, scope out, non-goals, and service/UX/security/support boundaries are recorded.
- Dependencies map to Plan 07, organization/workspace, settings/project lifecycle, Member/RBAC,
  tenant isolation/quotas, support SLA, Plan 50, ADR-0074, ADR-0077, and ADR-0080.
- Owning initiative dependencies map Admin Console, settings, Member/RBAC, tenant quotas, support,
  security verification, and Meta-cloud Broker consumption without taking their implementation
  scope.
- Read-model classes and action-intent categories are named with owners, visibility, and launch
  criticality.
- M1 evidence is listed as navigation information architecture, read-model contract, action-intent
  matrix, audit/redaction export, break-glass visibility fixture, and scope boundary register.
- Follow-up M1-M4 issues are blocked until M0 acceptance is recorded.

## Negative Coverage

- Scope validation rejects UI implementation, RBAC enforcement, support ticketing, tenant quota,
  billing, provider credential, live customer-data, status-page, or incident publishing creep.
- Request routing keeps RBAC, tenant/quota, support workflow, security verification, and broker
  decisions with their owning initiatives.
- Follow-up gating refuses M1-M4 issue creation while M0 is not accepted.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\admin-console-scope test
```
