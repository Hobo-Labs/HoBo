# Vibe Plan/Diff Review Prototype

Independent M2 proof for HOBO-560.

This package composes accepted HOBO-542 plan review states and HOBO-543
annotation pseudocode into deterministic golden plan/diff fixtures. It proves
review, risk, cost, capacity, policy, approval, and support-handoff behavior
without implementing planner, apply, rollback, approval services, live cost APIs,
or production UI.

## Contract Boundaries

- In scope: golden fixtures for create, update, no-op, destructive, blocked,
  stale, and unknown evidence plans; annotation composition; proof-mode labels;
  accessibility notes; and support handoff metadata.
- Consumed but not owned: HOBO-542 plan review states, HOBO-543 annotation
  pseudocode, and HOBO-577 quickstart fixture ids.
- Out of scope: planner/matcher/apply/rollback runtime, approval workflow
  implementation, live cost API or provider credentials, production plan/diff UI,
  and launch claims without evidence.

## Proof

```powershell
pnpm.cmd --dir src\draft\exp-proofs\vibe-plan-diff-review-prototype test
```

## Acceptance Map

| Acceptance | Evidence |
|---|---|
| Prototype consumes M1 plan review states and annotation pseudocode artifacts. | `resolvePlanDiffDependencies` and golden fixture composition import HOBO-542 and HOBO-543 exports. |
| Golden fixtures cover create, update, no-op, destructive, blocked, stale, and unknown evidence plans. | `goldenFixtures` pins the accepted state sequence and parser validation rejects missing states. |
| Target package and proof paths are pinned. | `parseVibePlanDiffReviewPrototype` rejects path drift. |
| Happy path, blocked path, stale/unknown evidence path, support handoff, accessibility notes, and proof-mode labels are covered. | `scenarios`, `supportHandoff`, `accessibilityNotes`, and proof-mode validation cover each acceptance state. |
| Scope out remains hard. | `classifyPlanDiffRequest` rejects planner/apply/approval, live cost API, production UI, and proofless launch requests. |

## Architecture Evidence

- `architecture/` - protobuf data shapes and CUE constraints for golden plan/diff fixtures.
- `architecture/pacts/` - Pact-style package boundary fixture.
- `ADR.md` - parse-don't-validate composition note over accepted M1 proofs.
