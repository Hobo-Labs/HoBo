---
type: Reference
title: "Vibe First-Run Activation Rail Proof"
description: "Source issue: HOBO-540."
tags: [hobo, design]
---

# Vibe first-run activation rail proof

`HOBO-540` creates first-run activation rail mockups and a state model for Workspace & Onboarding
UX. The executable proof lives in `src/draft/exp-proofs/ux/vibe-first-run-activation-rail`.

## Acceptance evidence

| Acceptance requirement | Branch evidence |
| --- | --- |
| Mockups or wireframes cover app developer, team admin, platform engineer, and support operator entry points. | `VIBE_FIRST_RUN_ACTIVATION_RAIL.wireframes` carries one entry record for each persona, with visible states, primary question, next action, and accessibility notes. |
| State model names entry/exit conditions, owner, evidence object, and missing-prerequisite behavior for every stage. | `stateModel` covers invite or try-it, workspace, project, plan preview, launch attempt, recovery, and value proof; parser tests require all required fields. |
| Target package path is `src/draft/exp-proofs/ux/vibe-first-run-activation-rail`. | Package metadata, README, and parser literal pin the target package. |
| Target proof path is `docs/design/proofs/vibe-first-run-activation-rail/README.md`. | This proof note is linked from traceability and pinned in the parser literal. |
| Covers happy path, blocked path, stale/unknown evidence path, support handoff, accessibility notes, and proof-mode labels. | `outcomes`, `wireframes`, `proofModeLegend`, and focused tests require happy, blocked, stale-or-unknown evidence, support handoff, live, simulated, reference fixture, and scope-out labels. |
| Scope out live provider calls, production UI, customer data, real credentials, and unsupported launch claims. | `scopeOut` plus `classifyActivationRailScope` reject those proposals. |

## Verification

```bash
pnpm --prefix src/draft/exp-proofs/ux/vibe-first-run-activation-rail test
```

Architecture and boundary artifacts:

- Protobuf: `src/draft/exp-proofs/ux/vibe-first-run-activation-rail/architecture/vibe_first_run_activation_rail.proto`
- CUE: `src/draft/exp-proofs/ux/vibe-first-run-activation-rail/architecture/vibe_first_run_activation_rail.cue`
- Pact-style fixture: `src/draft/exp-proofs/ux/vibe-first-run-activation-rail/architecture/pacts/vibe_first_run_activation_rail.pact.json`
