---
type: Reference
title: "HOBO-444 Teardown & Recovery M0 Scope Proof"
description: "Source issue: HOBO-444."
tags: [hobo, design]
---

# HOBO-444 Teardown & Recovery M0 Scope Proof

HOBO-444 is proven by the focused M0 contract at
[`src/draft/exp-proofs/dx/teardown-recovery-scope-acceptance`](../../../../src/draft/exp-proofs/dx/teardown-recovery-scope-acceptance/README.md)
and the durable scope record at [teardown-recovery.md](../../teardown-recovery.md).

## Acceptance Evidence

- Goal and personas are explicit for platform engineers, SRE operators, support operators,
  security reviewers, and customer admins.
- Scope in, scope out, non-goals, and service/UX/security/support boundaries are recorded.
- Dependencies map to Plan 04, Plan 05, Plan 07, Plan 25, Environment Lifecycle, Resource Garbage
  Collection, Backup & Restore, Upgrade & Migration Engine, Support SLA Channels, ADR-0004,
  ADR-0006, ADR-0058, ADR-0041, and ADR-0094.
- Owning initiative dependencies map Teardown & Recovery, Environment Lifecycle, Resource Garbage
  Collection, Backup & Restore, Upgrade & Migration Engine, Support Workflow, Control Plane, and
  Contracts/Policy without taking their implementation scope.
- Teardown states, recovery modes, and required evidence fields are listed for M1 proof.
- Follow-up M1-M4 issues are blocked until M0 acceptance is recorded.

## Negative Coverage

- Scope validation rejects live provider deletes, provider mutation, production teardown runtime,
  restore runtime, billing/refund/chargeback work, support ticket/SLA automation, customer
  notifications, and downstream issue-creation creep.
- Decision routing keeps provider adapters, backup restore drills, cleanup sweepers, support
  workflow, billing, and policy engine decisions with their owning initiatives.
- Follow-up gating refuses M1-M4 issue creation while M0 is not accepted.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\teardown-recovery-scope-acceptance test
```
