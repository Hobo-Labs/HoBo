---
type: Reference
title: "HOBO-505 Accessibility And Usability Launch Baseline Proof"
description: "Source issue: HOBO-505."
tags: [hobo, design]
---

# HOBO-505 Accessibility And Usability Launch Baseline Proof

HOBO-505 is proven by the focused M0 contract at
[`src/draft/exp-proofs/ux/accessibility-usability-launch-baseline-contract`](../../../../src/draft/exp-proofs/ux/accessibility-usability-launch-baseline-contract/README.md)
and the durable design record at
[`accessibility-usability-launch-baseline.md`](../../accessibility-usability-launch-baseline.md).

## Acceptance Evidence

- V1 target surfaces are named with owning product projects and launch evidence use.
- Required checks cover keyboard-only path, focus order, visible focus, semantic labels, contrast,
  responsive layout, reduced motion, screen-reader smoke, empty/error/loading states, and copy
  clarity.
- Evidence matrix separates automated checks, manual assistive-technology checks, beta feedback,
  defect severity, launch-blocker thresholds, and accepted-risk exceptions.
- Findings route to owning launch surfaces rather than a generic accessibility bucket.

## Negative Coverage

- A generic UX gate that omits required accessibility checks fails validation.
- Launch blockers cannot be waived by accepted-risk exception.
- Required evidence gates, CI, review, security, and contract-test gates cannot be overridden.
- Scope validation rejects product UI implementation and final audit-output creep.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\accessibility-usability-launch-baseline-contract test
```
