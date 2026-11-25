---
type: Reference
title: "HOBO-411 Plan/Diff Viewer M0 Scope Proof"
description: "Source issue: HOBO-411."
tags: [hobo, design]
---

# HOBO-411 Plan/Diff Viewer M0 Scope Proof

HOBO-411 is proven by the focused M0 contract at
[`src/draft/exp-proofs/ux/plan-diff-viewer-scope-acceptance`](../../../../src/draft/exp-proofs/ux/plan-diff-viewer-scope-acceptance/README.md)
and the durable scope record at [plan-diff-viewer.md](../../plan-diff-viewer.md).

## Acceptance Evidence

- User and business goal is explicit for pre-deploy plan and diff review.
- Primary personas cover app developer reviewer, platform engineer approver, security reviewer, and
  support operator.
- Scope in, scope out, non-goals, and service/UX/security/support boundaries are recorded.
- Dependencies map to Plan 07, Plan 04, Plan 25, Plan 05, Plan 29, ADR-0033, and ADR-0064.
- Owning initiative dependencies map Plan/Diff Viewer, Deployment Dashboard & Topology Explorer,
  Workspace & Onboarding UX, Security Verification, Support & Debug Tools, and V1 Release Program
  & Cutline without taking their scope.
- M1 evidence is listed as state model, golden fixtures, risk/policy annotations, cost/capacity
  summary, and blocked-plan support handoff.
- Follow-up M1-M4 work is blocked until M0 acceptance is recorded.

## Negative Coverage

- Scope validation rejects planner/apply, production dashboard, live-provider, and credential creep
  inside M0.
- Evidence validation rejects launch-facing claims without proof mode and source.
- Follow-up gating refuses M1-M4 issue creation while M0 is not accepted.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\plan-diff-viewer-scope-acceptance test
```
