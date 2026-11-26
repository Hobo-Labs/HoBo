---
type: Reference
title: "HOBO-500 Launch E2E Persona Matrix Proof"
description: "Source issue: HOBO-500."
tags: [hobo, design]
---

# HOBO-500 Launch E2E Persona Matrix Proof

HOBO-500 is proven by the focused M0 contract at
[`src/draft/exp-proofs/dx/v1-e2e-persona-matrix-contract`](../../../../src/draft/exp-proofs/dx/v1-e2e-persona-matrix-contract/README.md)
and the durable design record at
[`launch-e2e-persona-matrix.md`](../../launch-e2e-persona-matrix.md).

## Acceptance Evidence

- Matrix covers app developer, platform engineer, admin, support/operator, security reviewer, and
  customer/buyer journeys.
- Each journey names environment, fixture data, mocked/live boundary, expected evidence, and
  pass/fail threshold.
- Flake policy requires quarantine or explicit follow-up before launch confidence can pass.
- Manual evidence fallback requires reason, evidence link, and approver.
- Scope boundary keeps full e2e harness implementation, live provider execution, and broad device
  lab coverage out of this M0 issue.

## Negative Coverage

- Validation rejects missing persona journeys.
- Validation rejects generic gates that are not owned by HOBO-500.
- Validation rejects full e2e harness scope creep.
- Evidence evaluation rejects manual fallback when a launch blocker is open.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\v1-e2e-persona-matrix-contract test
```
