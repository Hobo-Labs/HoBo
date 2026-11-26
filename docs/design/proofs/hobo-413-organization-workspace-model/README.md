---
type: Reference
title: "HOBO-413 Organization & Workspace Model Proof"
description: "Source issue: HOBO-413."
tags: [hobo, design]
---

# HOBO-413 Organization & Workspace Model Proof

HOBO-413 is proven by the focused M0 contract at
[`src/draft/exp-proofs/api/organization-workspace-model-contract`](../../../../src/draft/exp-proofs/api/organization-workspace-model-contract/README.md)
and the durable scope record at
[`organization-workspace-model.md`](../../organization-workspace-model.md).

## Acceptance Evidence

- The record states the v1 organization/workspace goal, primary personas, scope in/out, and non-goals.
- It maps service, UX, security, and support boundaries to the correct owning projects.
- It cites architecture, developer experience, app tenancy, org governance, and tenant isolation sources.
- It records M1 evidence requirements for domain model, RBAC, tenant/quota, project lifecycle, and support/audit handoffs.
- It keeps follow-up implementation issues blocked until M0 scope acceptance is recorded.

## Negative Coverage

- Scope validation rejects implementation work, production workspace flows, invite flows, RBAC engines, quota enforcement, live customer data, and other customer-data scope creep in this slice.
- Workspace decisions route to adjacent owners instead of silently expanding this issue.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\organization-workspace-model-contract test
```
