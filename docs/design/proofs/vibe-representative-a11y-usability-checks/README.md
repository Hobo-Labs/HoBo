---
type: Design Proof Evidence
title: "HOBO-565 Vibe Representative Accessibility And Usability Checks Proof"
description: "M2 proof record for representative keyboard, screen-reader, responsive, contrast, reduced-motion, state-clarity, and copy checks across vibe artifacts."
tags: [hobo, proof, accessibility, usability, vibe]
timestamp: 2026-07-01T00:00:00Z
---

# HOBO-565 Vibe Representative Accessibility And Usability Checks Proof

This proof records branch evidence for representative accessibility and usability
checks across the downstream vibe artifact family.

## Evidence

- Source checklist: [`vibe-accessibility-usability-checklist`](../vibe-accessibility-usability-checklist/README.md).
- Quickstart source: [`resource-lifecycle-quickstart-examples`](../resource-lifecycle-quickstart-examples/README.md).
- Executable proof: [`vibe-representative-a11y-usability-checks`](../../../../src/draft/exp-proofs/ux/vibe-representative-a11y-usability-checks/README.md).

## Acceptance Coverage

| Acceptance | Proof |
|---|---|
| Check fixtures cover onboarding, plan/diff, deployment dashboard, marketplace, docs, support, publisher, and launch-demo artifacts. | `artifactChecks` covers all eight artifacts and pins the HOBO-577 fixture each consumes. |
| Each check names expected evidence, severity, owner route, accepted-risk path, and launch readiness impact. | `RepresentativeCheckEvidence` carries those fields, and tests reject missing evidence metadata. |
| Target package and proof path match the issue. | `parseVibeRepresentativeA11yUsabilityChecks` rejects path drift from the target package and proof path. |
| Happy path, blocked path, stale/unknown evidence path, support handoff, accessibility notes, and proof labels are covered. | `scenarios` records all six required scenario paths with artifacts, required evidence, and safe outcomes. |
| Source blockers are consumed as evidence. | `sourceIssues` pins HOBO-554 and HOBO-577; `quickstartFixtureRefs` pins accepted fixture ids and consuming artifacts. |

## Adversarial Evidence

The parser and tests reject requests that try to turn this proof into a full
accessibility audit, product UI remediation, automated accessibility test suite,
launch waiver approval, customer-data evidence, or launch claims without named
evidence.

## Verification

```powershell
pnpm.cmd run test:file src/draft/exp-proofs/ux/vibe-representative-a11y-usability-checks/test/vibe-representative-a11y-usability-checks.test.ts
```
