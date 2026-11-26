---
type: Reference
title: "HOBO-484 V1 Critical Path Dependencies Proof"
description: "Source issue: HOBO-484."
tags: [hobo, design]
---

# HOBO-484 V1 Critical Path Dependencies Proof

This proof records the M0 dependency map for V1 Release Program & Cutline.

## Evidence

- Product UX, tenant model, billing, install, docs, testing, support, security, compliance, and
  operations domains are all represented.
- Every dependency names blocker type, upstream project, downstream gate, and owner.
- Private beta, release-candidate, and GA blockers are separated.
- Out-of-scope dependency work is recorded as known limitations instead of hidden execution scope.

## Focused Gate

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\v1-critical-path-dependency-map-contract test
```

## Scope

This branch does not implement product UX, tenant, billing, installer, documentation, testing,
support, security, compliance, operations, release go/no-go, legal approval, payment provider, or
runtime feature work.
