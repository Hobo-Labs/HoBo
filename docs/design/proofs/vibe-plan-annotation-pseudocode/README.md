---
type: Reference
title: "Vibe Plan Annotation Pseudocode Proof"
description: "Source issue: HOBO-543."
tags: [hobo, design]
---

# Vibe Plan Annotation Pseudocode Proof Note

HOBO-543 proves the policy, cost, capacity, and approval annotation pseudocode for Plan/Diff Viewer
vibe artifacts. The source package is
[`src/draft/exp-proofs/ux/vibe-plan-annotation-pseudocode`](../../../../src/draft/exp-proofs/ux/vibe-plan-annotation-pseudocode/README.md).

## Acceptance Mapping

- Pseudocode fields: `renderAnnotationPseudocode` names annotation input, display grouping,
  severity, proof mode, missing evidence, and support owner routing.
- Fixture coverage: the parsed contract includes policy denial, widened permission, cost estimate,
  capacity warning, stale SLO signal, and missing approval examples.
- Proof labels: fixtures are explicitly reference fixture, simulated, or scope-out; live proof mode
  is rejected by the evaluator.
- Blocked and stale states: policy/capacity/approval blocks and stale SLO evidence carry support
  owner routes and customer-safe wording.
- Guardrails: scope creep into policy engine, approval runtime, billing, quota, live cloud cost API,
  credentials, production UI, or launch claims is rejected.

## Verification

```powershell
pnpm.cmd --dir src\draft\exp-proofs\vibe-plan-annotation-pseudocode test
```

## Scope Out

This proof does not implement production policy, billing, quota, approval, provider cost, dashboard,
credential, customer-data, or launch-publication behavior. It is an independent fixture contract
consuming the HOBO-577 quickstart shape without importing unmerged blocker code.
