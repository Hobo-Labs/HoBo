---
type: Reference
title: "HOBO-403 Dogfood Yard Acceptance Proof"
description: "Source issue: HOBO-403."
tags: [hobo, design]
---

# HOBO-403 Dogfood Yard Acceptance Proof

HOBO-403 is proven by the focused M0 contract at
[`src/draft/exp-proofs/dx/dogfood-yard-acceptance-contract`](../../../../src/draft/exp-proofs/dx/dogfood-yard-acceptance-contract/README.md)
and the durable scope record at [dogfood-yard.md](../../dogfood-yard.md).

## Acceptance Evidence

- Dogfood personas are explicit for platform engineering, hosted operations, SRE/support, and
  release readiness.
- Hosted and self-hosted Yard acceptance scenarios are listed.
- Required logs, traces, status views, support/debug evidence, and rollback signals are defined.
- Evidence ownership maps to operational, admin, bootstrap, and reliability project boundaries.
- Authoritative dependencies link to Plan 04, the role walkthrough, Plan 07, Plan 05, Plan 40, and
  ADR-0092.

## Negative Coverage

- Scope validation rejects Yard build work inside M0.
- Scope validation rejects live provider calls, provider credentials, live customer data, and
  readiness claims.
- Follow-up evidence work remains blocked until M0 acceptance is recorded.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\dogfood-yard-acceptance-contract test
```
