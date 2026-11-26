---
type: Reference
title: "HOBO-443 Resource Garbage Collection Proof"
description: "Source issue: HOBO-443."
tags: [hobo, design]
---

# HOBO-443 Resource Garbage Collection Proof

This proof backs the M0 productization record for
[Resource Garbage Collection](../../resource-garbage-collection.md).

## Branch Evidence

- Issue: HOBO-443
- Draft package:
  [`src/draft/exp-proofs/dx/resource-garbage-collection-scope-acceptance`](../../../../src/draft/exp-proofs/dx/resource-garbage-collection-scope-acceptance/README.md)
- Focused gate:
  `npm.cmd --prefix src\draft\exp-proofs\resource-garbage-collection-scope-acceptance test`

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| User/business goal and primary personas are explicit. | `RESOURCE_GARBAGE_COLLECTION_SCOPE.goal` and `personas` are asserted by package tests. |
| Scope in/out and non-goals are recorded. | Scope arrays and non-goals are documented and validated. |
| Initiative dependencies and service/UX/security/support boundaries are mapped. | Boundary and initiative dependency records are asserted. |
| Evidence required for M1 design and contract proof is listed. | Six M1 evidence records are asserted by the test suite. |
| Follow-up M1/M2/M3/M4 issues wait for M0 acceptance. | `canCreateResourceGarbageCollectionFollowUp` blocks implementation phases until `m0Accepted` is true. |

## Adversarial Coverage

The executable proof rejects productization creep into provider adapter sweepers, live cloud deletes,
production cleanup runtime, legal retention policy, billing/chargeback, drift runtime replacement,
and support ticketing. It also requires policy-window evidence so suspected garbage cannot become a
silent destructive-action bypass.
