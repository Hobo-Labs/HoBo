---
type: Reference
title: "HOBO-414 Environment Lifecycle M0 Scope Proof"
description: "Source issue: HOBO-414."
tags: [hobo, design]
---

# HOBO-414 Environment Lifecycle M0 Scope Proof

HOBO-414 is proven by the focused M0 contract at
[`src/draft/exp-proofs/dx/environment-lifecycle-scope`](../../../../src/draft/exp-proofs/dx/environment-lifecycle-scope/README.md)
and the durable scope record at [environment-lifecycle.md](../../environment-lifecycle.md).

## Acceptance Evidence

- Goal and personas are explicit for workspace admins, project owners, platform engineers, and
  support operators.
- Scope in, scope out, non-goals, and service/UX/security/support boundaries are recorded.
- Dependencies map to Settings & Project Lifecycle, Organization & Workspace Model, Plan 07,
  Plan 25, Plan 50, support, backup/restore, cleanup, ADR-0077, ADR-0079, ADR-0080, and ADR-0042.
- Owning initiative dependencies map Environment Lifecycle, Settings, Admin Console, Deployment
  Dashboard, Tenant Isolation & Quotas, Backup & Restore, Resource Garbage Collection, and Support
  Workflow consumption without taking their scope.
- M1 evidence is listed as environment schema, lifecycle state machine, transition-owner matrix,
  audit event fixture, support export contract, and scope boundary register.
- Follow-up M1-M4 issues are blocked until M0 acceptance is recorded.

## Negative Coverage

- Scope validation rejects environment runtime, live provider/DNS provisioning, admin UI, RBAC,
  quota/billing, backup/restore, live cleanup, drift, teardown, and downstream issue-creation creep.
- Evidence validation rejects environment claims missing required parent-project, owner, tenant,
  policy, deployment, restore, cleanup, or support proof fields.
- Follow-up gating refuses M1-M4 issue creation while M0 is not accepted.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\environment-lifecycle-scope test
```
