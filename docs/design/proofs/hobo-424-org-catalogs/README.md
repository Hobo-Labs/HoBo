---
type: Reference
title: "HOBO-424 Org Catalogs Proof"
description: "Source issue: HOBO-424."
tags: [hobo, design]
---

# HOBO-424 Org Catalogs Proof

This proof backs the M0 productization record for
[Org Catalogs](../../org-catalogs.md).

## Branch Evidence

- Issue: HOBO-424
- Draft package:
  [`src/draft/exp-proofs/dx/org-catalogs-scope-acceptance`](../../../../src/draft/exp-proofs/dx/org-catalogs-scope-acceptance/README.md)
- Focused gate:
  `npm.cmd --prefix src\draft\exp-proofs\org-catalogs-scope-acceptance test`

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| User/business goal and primary personas are explicit. | `ORG_CATALOGS_SCOPE.goal` and `personas` are asserted by package tests. |
| Scope in/out and non-goals are recorded. | Scope arrays and non-goals are documented and validated. |
| Initiative dependencies and service/UX/security/support boundaries are mapped. | Boundary and initiative dependency records are asserted. |
| Evidence required for M1 design and contract proof is listed. | Six M1 evidence records are asserted by the test suite. |
| Follow-up M1/M2/M3/M4 issues wait for M0 acceptance. | `canCreateOrgCatalogFollowUp` blocks implementation phases until `m0Accepted` is true. |

## Adversarial Coverage

The executable proof rejects productization creep into install resolver runtime, live registry
storage, marketplace/payout work, billing, RBAC grants, and provider execution. It also requires
policy evidence on catalog entries so approval cannot become an unowned bypass around governance.
