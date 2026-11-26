---
type: Reference
title: "HOBO-449 Customer Onboarding Proof"
description: "Source issue: HOBO-449."
tags: [hobo, design]
---

# HOBO-449 Customer Onboarding Proof

This proof backs the M0 productization record for
[Customer Onboarding](../../customer-onboarding.md).

## Branch Evidence

- Issue: HOBO-449
- Draft package:
  [`src/draft/exp-proofs/cx/customer-onboarding-scope-acceptance`](../../../../src/draft/exp-proofs/cx/customer-onboarding-scope-acceptance/README.md)
- Focused gate:
  `pnpm.cmd --prefix src\draft\customer-onboarding-scope-acceptance test`

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| User/business goal and primary personas are explicit. | `CUSTOMER_ONBOARDING_SCOPE.goal` and `personas` are asserted by package tests. |
| Scope in/out and non-goals are recorded. | Scope arrays and non-goals are documented and validated. |
| Owning initiative dependencies and service/UX/security/support boundaries are mapped. | Dependency and boundary records are documented in the design record and carried in the executable scope. |
| Evidence required for M1 design and contract proof is listed. | Six M1 evidence records are asserted by the test suite. |
| Follow-up M1/M2/M3/M4 issues are created only after M0 acceptance. | `canStartCustomerOnboardingFollowUp` blocks implementation phases until `m0Accepted` is true. |

## Adversarial Coverage

The executable proof rejects scope creep into CRM/customer-success systems, live
customer data or production tenant records, launch marketing or sales surfaces,
and customer-facing onboarding claims that lack proof mode and source evidence.
