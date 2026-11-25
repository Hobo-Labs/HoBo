---
type: Reference
title: "HOBO-415 Tenant Isolation & Quotas Proof"
description: "Source issue: HOBO-415."
tags: [hobo, design]
---

# HOBO-415 Tenant Isolation & Quotas Proof

This proof backs the M0 productization record for
[Tenant Isolation & Quotas](../../tenant-isolation-quotas.md).

## Branch Evidence

- Issue: HOBO-415
- Draft package:
  [`src/draft/exp-proofs/dx/tenant-isolation-quotas-scope`](../../../../src/draft/exp-proofs/dx/tenant-isolation-quotas-scope/README.md)
- Focused gate:
  `npm.cmd --prefix src\draft\exp-proofs\tenant-isolation-quotas-scope test`

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| User/business goal and primary personas are explicit. | `TENANT_ISOLATION_QUOTAS_SCOPE.goal` and `personas` are asserted by package tests. |
| Scope in/out and non-goals are recorded. | Scope arrays and non-goals are documented and validated. |
| Initiative dependencies and service/UX/security/support boundaries are mapped. | Boundary and initiative dependency records are asserted. |
| Evidence required for M1 design and contract proof is listed. | Six M1 evidence records are asserted by the test suite. |
| Follow-up M1/M2/M3/M4 issues wait for M0 acceptance. | `canCreateFollowUpIssue` blocks implementation phases until `m0Accepted` is true. |

## Adversarial Coverage

The executable proof rejects productization creep into billing, runtime enforcement, RBAC,
tenant-admin UI, provider provisioning, and live customer data. It also rejects collapsing platform
tenant and app tenant into one generic tenant axis.
