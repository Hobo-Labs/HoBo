---
type: Reference
title: "Vibe Clickable First-Run Walkthrough Proof"
description: "Source issue: HOBO-559."
tags: [hobo, design]
---

# Vibe clickable first-run walkthrough proof

`HOBO-559` creates a clickable/reference first-run walkthrough using snapshop
fixtures for Workspace & Onboarding UX. The executable proof lives in
`src/draft/exp-proofs/ux/vibe-clickable-first-run-walkthrough`.

## Acceptance evidence

| Acceptance requirement | Branch evidence |
| --- | --- |
| Walkthrough uses deterministic snapshop fixture data and consumes the M1 activation rail plus workspace/project state artifacts. | `consumedActivationRail` pins HOBO-540 stages; `consumedWorkspaceProjectStates` pins HOBO-541 states; each step names `snapshopFixture` and quickstart fixture ids. |
| Prototype labels each step as live, simulated, reference fixture, or scope-out and includes expected support/docs handoffs. | `steps` carry `proofMode`, `docsHandoff`, and `supportHandoff`; `handoffRoutes` cover docs portal, tutorials, troubleshooting, and support workflow surfaces. |
| Target package path is `src/draft/exp-proofs/ux/vibe-clickable-first-run-walkthrough`. | Package metadata, README, and parser literal pin the target package. |
| Target proof path is `docs/design/proofs/vibe-clickable-first-run-walkthrough/README.md`. | This proof note is linked from traceability and pinned in the parser literal. |
| Covers happy path, blocked path, stale/unknown evidence path, support handoff, accessibility notes, and proof-mode labels. | `scenarioPaths`, `supportHandoffEvidence`, `accessibilityNotes`, and proof-mode tests require happy, blocked, stale-or-unknown, support handoff, live, simulated, reference fixture, and scope-out labels. |
| Scope out production onboarding UI, auth/account/billing, live provider calls, customer data, and launch claims without evidence. | `scopeOut` plus `classifyClickableFirstRunWalkthroughRequest` reject those proposals. |

## Verification

```bash
pnpm --prefix src/draft/exp-proofs/ux/vibe-clickable-first-run-walkthrough test
```

Architecture and boundary artifacts:

- Protobuf: `src/draft/exp-proofs/ux/vibe-clickable-first-run-walkthrough/architecture/vibe_clickable_first_run_walkthrough.proto`
- CUE: `src/draft/exp-proofs/ux/vibe-clickable-first-run-walkthrough/architecture/vibe_clickable_first_run_walkthrough.cue`
- Pact-style fixture: `src/draft/exp-proofs/ux/vibe-clickable-first-run-walkthrough/architecture/pacts/vibe_clickable_first_run_walkthrough.pact.json`
