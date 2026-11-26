---
type: Reference
title: "HOBO-451 Threat Model & Security Review Proof"
description: "Source issue: HOBO-451."
tags: [hobo, design]
---

# HOBO-451 Threat Model & Security Review Proof

This proof backs the M0 productization record for
[Threat Model & Security Review](../../threat-model-security-review.md).

## Branch Evidence

- Issue: HOBO-451
- Draft package:
  [`src/draft/exp-proofs/dx/threat-model-security-review-scope-acceptance`](../../../../src/draft/exp-proofs/dx/threat-model-security-review-scope-acceptance/README.md)
- Focused gate:
  `pnpm.cmd --dir src\draft\exp-proofs\threat-model-security-review-scope-acceptance test`

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| User/business goal and primary personas are explicit. | `THREAT_MODEL_SECURITY_REVIEW_SCOPE.goal` and `personas` are asserted by package tests. |
| Scope in/out and non-goals are recorded. | Scope arrays and non-goals are documented and validated. |
| Owning initiative dependencies and service/UX/security/support boundaries are mapped. | Dependency and boundary records are documented in the design record and carried in the executable scope. |
| Evidence required for M1 design and contract proof is listed. | Intake fields and review gates are asserted by the test suite. |
| Follow-up M1/M2/M3/M4 issues are created only after M0 acceptance. | `canStartThreatReviewFollowUp` blocks implementation phases until `m0Accepted` is true. |

## Adversarial Coverage

The executable proof rejects scope creep into live scanners, exploit runners,
required-gate bypasses, final legal/advisory copy, and release-facing finding
classification without fix-verification state.
