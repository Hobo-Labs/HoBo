---
type: Design Proof Evidence
title: "HOBO-563 Vibe Pilot First-Proof Walkthrough Proof"
description: "M2 proof record for pilot workspace-to-first-proof walkthrough and blocker routing."
tags: [hobo, proof, customer-onboarding, pilot, vibe]
timestamp: 2026-07-01T00:00:00Z
---

# HOBO-563 Vibe Pilot First-Proof Walkthrough Proof

This proof records branch evidence for the pilot workspace-to-first-proof
walkthrough with blocker routing.

## Evidence

- Customer onboarding source: [`customer-onboarding.md`](../../customer-onboarding.md).
- Workspace source: [`workspace-onboarding-ux.md`](../../workspace-onboarding-ux.md).
- Support workflow source: [`support-workflow.md`](../../support-workflow.md).
- Consumed storyboard proof: [`vibe-first-customer-pilot-storyboard`](../vibe-first-customer-pilot-storyboard/README.md).
- Executable proof: [`vibe-pilot-first-proof-walkthrough`](../../../../src/draft/exp-proofs/ux/vibe-pilot-first-proof-walkthrough/README.md).

## Acceptance Coverage

| Acceptance | Proof |
|---|---|
| Walkthrough consumes the first-customer pilot storyboard and script artifacts. | `consumedStoryboard` pins HOBO-549 package, proof, and required stage order, and tests import the HOBO-549 stage constants. |
| Deterministic scenario covers invite, workspace setup, sample-or-real project choice, first proof, failure recovery, support handoff, and feedback capture. | `steps` cover every accepted HOBO-549 stage and `scenarioPaths` cover happy, blocked, stale/unknown, and support handoff routes. |
| Package and proof path match the issue. | `parseVibePilotFirstProofWalkthrough` rejects drift from `src/draft/exp-proofs/ux/vibe-pilot-first-proof-walkthrough` and this proof path. |
| Happy path, blocked path, stale/unknown evidence path, support handoff, accessibility notes, and proof-mode labels are covered. | Tests assert scenario coverage, support handoff fields, keyboard/screen reader/color/motion notes, and live/simulated/reference fixture/scope-out labels. |
| Blockers route to cutline, docs, product UX, support, or engineering. | `blockerRoutes` pins those exact owner routes with trigger, owner, safe next action, and customer-safe message fields. |

## Adversarial Evidence

The parser and tests reject requests that try to turn this proof into
customer-success automation, CRM, live customer data, production tenant
mutation, provider deployment, support tooling, or launch readiness claims
without evidence. Stale or unknown evidence cannot be marked green.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\vibe-pilot-first-proof-walkthrough test
```
