---
type: Reference
title: "HOBO-419 Entitlements & Plan Limits Proof"
description: "Source issue: HOBO-419."
tags: [hobo, design]
---

# HOBO-419 Entitlements & Plan Limits Proof

This proof backs the M0 productization record for
[Entitlements & Plan Limits](../../entitlements-plan-limits.md).

## Branch Evidence

- Issue: HOBO-419
- Draft package:
  [`src/draft/exp-proofs/cx/entitlements-plan-limits-scope`](../../../../src/draft/exp-proofs/cx/entitlements-plan-limits-scope/README.md)
- Focused gate:
  `npm.cmd --prefix src\draft\exp-proofs\entitlements-plan-limits-scope test`

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| User/business goal and primary personas are explicit. | `ENTITLEMENTS_PLAN_LIMITS_SCOPE.goal` and `personas` are asserted by package tests. |
| Scope in/out and non-goals are recorded. | Scope arrays and non-goals are documented and validated. |
| Initiative dependencies and service/UX/security/support boundaries are mapped. | Boundary and initiative dependency records are asserted. |
| Evidence required for M1 design and contract proof is listed. | Six M1 evidence records are asserted by the test suite. |
| Follow-up M1/M2/M3/M4 issues wait for M0 acceptance. | `canCreateEntitlementsFollowUp` blocks implementation phases until `m0Accepted` is true. |

## Adversarial Coverage

The executable proof rejects productization creep into billing, runtime enforcement, RBAC, provider
quota sync, fraud/abuse response, and live customer plan mutation. It also requires all entitlement
decision states, including overrides, to carry audit evidence.
