---
type: Reference
title: "HOBO-412 Settings & Project Lifecycle M0 Scope Proof"
description: "Source issue: HOBO-412."
tags: [hobo, design]
---

# HOBO-412 Settings & Project Lifecycle M0 Scope Proof

HOBO-412 is proven by the focused M0 contract at
[`src/draft/exp-proofs/ux/settings-project-lifecycle-scope`](../../../../src/draft/exp-proofs/ux/settings-project-lifecycle-scope/README.md)
and the durable scope record at [settings-project-lifecycle.md](../../settings-project-lifecycle.md).

## Acceptance Evidence

- Goal and personas are explicit for workspace admins, project owners, platform engineers, and
  support operators.
- Scope in, scope out, non-goals, and service/UX/security/support boundaries are recorded.
- Dependencies map to Plan 07, Plan 10, Plan 50, ADR-0077, and ADR-0074.
- Owning initiative dependencies map Settings, RBAC, tenant quotas, environment lifecycle,
  deployment dashboard, and support workflow consumption without taking their scope.
- M1 evidence is listed as settings schema, project lifecycle state machine, audit event fixture,
  RBAC boundary matrix, and support export contract.
- Follow-up M1-M4 issues are blocked until M0 acceptance is recorded.

## Negative Coverage

- Scope validation rejects admin-console, RBAC enforcement, tenant-quota, billing, provider
  credential, or live-provider implementation creep inside M0.
- Evidence validation rejects customer-visible settings claims without a proof mode.
- Follow-up gating refuses M1-M4 issue creation while M0 is not accepted.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\settings-project-lifecycle-scope test
```
