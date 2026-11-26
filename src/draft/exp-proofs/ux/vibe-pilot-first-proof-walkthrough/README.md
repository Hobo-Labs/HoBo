# Vibe Pilot First-Proof Walkthrough

Independent M2 proof for HOBO-563.

This package records a deterministic pilot workspace-to-first-proof walkthrough
that consumes the accepted HOBO-549 first-customer storyboard and routes every
blocked step to cutline, docs, product UX, support, or engineering without
exposing live customer data.

## Audience

- Pilot customer champion
- Customer success lead
- Support engineer
- Release owner
- Security reviewer

## Contract Boundaries

- In scope: invite, workspace setup, sample-or-real project choice, first proof,
  failure recovery, support handoff, feedback capture, blocker routing,
  customer-safe messages, proof-mode labels, accessibility notes, and stale
  evidence refusal.
- Consumed: HOBO-549 `vibe-first-customer-pilot-storyboard` stages and proof
  note.
- Out of scope: customer-success automation, CRM, live customer data, production
  tenant mutation, provider deployment, support tooling, and launch claims
  without evidence.

## Proof

```powershell
npm.cmd --prefix src\draft\exp-proofs\vibe-pilot-first-proof-walkthrough test
```

## Acceptance Map

| Acceptance | Evidence |
|---|---|
| Walkthrough consumes the first-customer pilot storyboard and script artifacts. | `consumedStoryboard` pins HOBO-549 package, proof, and stage order; tests import HOBO-549 constants. |
| Deterministic scenario covers invite, workspace setup, sample-or-real project choice, first proof, failure recovery, support handoff, and feedback capture. | `steps` and `scenarioPaths` cover every stage and parser tests reject missing coverage. |
| Target package and proof paths are pinned. | `parseVibePilotFirstProofWalkthrough` rejects path drift. |
| Happy path, blocked path, stale/unknown evidence path, support handoff, accessibility notes, and proof-mode labels are covered. | Scenario, support handoff, accessibility, and proof-mode tests pin each state. |
| Blockers route to cutline, docs, product UX, support, or engineering. | `blockerRoutes` is an exact parsed route set with owner and safe next action fields. |
| Scope out remains hard. | `classifyPilotFirstProofWalkthroughRequest` rejects automation, CRM, live customer data, tenant mutation, provider deployment, support tooling, and proofless launch claims. |

## Architecture Evidence

- `architecture/` - protobuf data shapes and CUE constraints for the walkthrough
  record.
- `architecture/pacts/` - Pact-style package boundary fixture.
- `ADR.md` - parse-don't-validate and event/projection architecture note.
- `pnpm-lock.yaml` - workspace importer registration for this proof package and
  the current rebased draft workspace set so `install:check` remains
  deterministic.
