# Vibe Clickable First-Run Walkthrough

Independent M2 proof for HOBO-559.

This package records a clickable/reference first-run walkthrough using snapshop
fixtures. It consumes the accepted HOBO-540 activation rail and HOBO-541
workspace/project state artifacts, moving from workspace entry through project
setup, plan preview, blocked/recovery, and value proof.

## Audience

- App developer
- Team admin
- Platform engineer
- Support operator

## Contract Boundaries

- In scope: snapshop fixture walkthrough steps, proof-mode labels, docs/support
  handoffs, scenario paths, accessibility notes, and stale evidence refusal.
- Consumed: HOBO-540 activation rail stages and HOBO-541 workspace/project
  state fixtures.
- Out of scope: production onboarding UI, auth/account/billing services, live
  provider calls, customer data, and launch claims without evidence.

## Proof

```bash
pnpm --prefix src/draft/exp-proofs/ux/vibe-clickable-first-run-walkthrough test
```

## Acceptance Map

| Acceptance | Evidence |
|---|---|
| Walkthrough uses deterministic snapshop fixture data and consumes M1 activation rail plus workspace/project state artifacts. | `consumedActivationRail` and `consumedWorkspaceProjectStates` pin HOBO-540/541 packages; each step names snapshop fixture ids and quickstart refs. |
| Prototype labels each step as live, simulated, reference fixture, or scope-out and includes expected support/docs handoffs. | `steps` carry `proofMode`, `docsHandoff`, and `supportHandoff`; `handoffRoutes` cover docs portal, tutorials, troubleshooting, and support workflow. |
| Target package path is `src/draft/exp-proofs/ux/vibe-clickable-first-run-walkthrough`. | `parseVibeClickableFirstRunWalkthrough` rejects path drift. |
| Target proof path is `docs/design/proofs/vibe-clickable-first-run-walkthrough/README.md`. | Parser literal and this proof note pin the target path. |
| Covers happy path, blocked path, stale/unknown evidence path, support handoff, accessibility notes, and proof-mode labels. | `scenarioPaths`, support handoff, accessibility, and proof-mode tests pin each state. |
| Scope out remains hard. | `classifyClickableFirstRunWalkthroughRequest` rejects production UI, auth/account/billing, live providers, customer data, and proofless launch claims. |

## Architecture Evidence

- `architecture/` - protobuf data shapes and CUE constraints for the walkthrough record.
- `architecture/pacts/` - Pact-style package boundary fixture.
- `ADR.md` - parse-don't-validate and event/projection architecture note.
