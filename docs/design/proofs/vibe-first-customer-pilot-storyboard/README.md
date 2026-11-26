---
type: Design Proof Evidence
title: "HOBO-549 Vibe First-Customer Pilot Storyboard Proof"
description: "M1 proof record for first-customer pilot storyboard and script artifacts."
tags: [hobo, proof, customer-onboarding, pilot, vibe]
timestamp: 2026-07-01T00:00:00Z
---

# HOBO-549 Vibe First-Customer Pilot Storyboard Proof

This proof records branch evidence for the first-customer pilot storyboard and
script artifact slice.

## Evidence

- Source record: [`customer-onboarding.md`](../../customer-onboarding.md).
- Workspace source: [`workspace-onboarding-ux.md`](../../workspace-onboarding-ux.md).
- Beta feedback source: [`beta-pilot-feedback.md`](../../beta-pilot-feedback.md).
- Quickstart source: [`resource-lifecycle-quickstart-examples`](../resource-lifecycle-quickstart-examples/README.md).
- Executable proof: [`vibe-first-customer-pilot-storyboard`](../../../../src/draft/exp-proofs/ux/vibe-first-customer-pilot-storyboard/README.md).

## Acceptance Coverage

| Acceptance | Proof |
|---|---|
| Storyboard covers pilot customer champion, customer success lead, support engineer, release owner, and security reviewer roles. | `test/vibe-first-customer-pilot-storyboard.test.ts` asserts every required persona has a storyboard step with a concrete operating question. |
| Script artifacts include stage, entry/exit criteria, consent state, proof mode, blocker category, owner, safe next action, and customer-safe message. | `scriptArtifacts` carry those fields for invite, workspace setup, project choice, first proof, failure recovery, support handoff, and feedback capture. |
| Package and proof path match the issue. | `parseVibeFirstCustomerPilotStoryboard` rejects path drift from the target package and proof path. |
| Happy path, blocked path, stale/unknown evidence path, support handoff, accessibility notes, and proof modes are covered. | `scenarioPaths`, `accessibilityNotes`, and proof-mode validation cover each acceptance state and label. |
| Pilot fixtures consume accepted HOBO-577 quickstart fixture ids. | `quickstartFixtureRefs` pins `rlq-define-object-graph-v1`, `rlq-plan-safe-preview-v1`, `rlq-deploy-run-accepted-v1`, `rlq-manage-stale-evidence-v1`, and `rlq-recover-scope-out-v1` with pilot-use notes. |

## Adversarial Evidence

The parser and tests reject requests that try to turn this proof into CRM,
customer-success automation, support tooling, live customer data, production
tenant mutation, provider deployment, or launch readiness claims without
evidence.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\vibe-first-customer-pilot-storyboard test
```
