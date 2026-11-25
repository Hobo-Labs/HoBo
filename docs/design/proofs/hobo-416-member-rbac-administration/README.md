---
type: Reference
title: "HOBO-416 Member/RBAC Administration M0 Scope Proof"
description: "Source issue: HOBO-416."
tags: [hobo, design]
---

# HOBO-416 Member/RBAC Administration M0 Scope Proof

HOBO-416 is proven by the focused M0 contract at
[`src/draft/exp-proofs/ux/member-rbac-administration-scope`](../../../../src/draft/exp-proofs/ux/member-rbac-administration-scope/README.md)
and the durable scope record at [member-rbac-administration.md](../../member-rbac-administration.md).

## Acceptance Evidence

- Goal and personas are explicit for workspace admins, security/policy admins, project owners, and
  support auditors.
- Scope in, scope out, non-goals, and service/UX/security/support boundaries are recorded.
- Dependencies map to Organization & Workspace Model, Settings & Project Lifecycle, Tenant
  Isolation & Quotas, Plan 07, Plan 12, ADR-0074, and ADR-0077.
- Owning initiative dependencies map Member/RBAC, org/workspace, settings/project lifecycle,
  tenant quotas, security verification, and support workflow consumption without taking their scope.
- M1 evidence is listed as membership state model, role authority matrix, SSO/SCIM binding fixture,
  no-self-escalation gate, audit/support export, and scope boundary register.
- Follow-up M1-M4 issues are blocked until M0 acceptance is recorded.

## Negative Coverage

- Scope validation rejects RBAC enforcement, SSO/SCIM sync, admin-console UI, provider access,
  billing, tenant-quota, or live-customer-data implementation creep inside M0.
- Decision routing keeps project lifecycle, tenant/quota, security verification, and support
  workflow decisions with their owning initiatives.
- Follow-up gating refuses M1-M4 issue creation while M0 is not accepted.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\member-rbac-administration-scope test
```
