# Vibe Plan Review States

Independent M1 proof for HOBO-542.

This package records plan review mockup contracts for safe, blocked,
destructive, stale, and unknown evidence states. It proves the information model
for Plan/Diff review without implementing the planner, matcher, apply,
rollback, approval workflow, live cost APIs, provider credentials, production UI,
or launch claims.

## Contract Boundaries

- In scope: review surfaces, state fixtures, persona questions, risk and policy
  disposition, cost/capacity labels, proof-mode labels, accessibility notes, and
  support handoff metadata.
- Quickstart dependency: Plan/Diff surfaces cite accepted HOBO-577 quickstart
  fixture ids `rlq-plan-safe-preview-v1`, `rlq-manage-stale-evidence-v1`,
  `rlq-migrate-brownfield-preview-v1`, and
  `rlq-recover-snapshot-restore-v1`.
- Consumed but not owned: DeploymentPlan, ResourcePlan, Gatekeeper,
  DeploymentSet, Delta, migration previews, rollback evidence, policy
  decisions, cost/capacity signals, and support workflow records.
- Out of scope: production plan viewer UI, planner/matcher/apply/rollback
  runtime, approval workflow implementation, live provider or cost calls,
  credentials, and launch readiness claims without evidence.

## Proof

```powershell
npm.cmd --prefix src\draft\exp-proofs\vibe-plan-review-states test
```

## Acceptance Map

| Acceptance | Evidence |
|---|---|
| Mockups distinguish create, update, no-op, destructive, blocked, stale, and unknown evidence states. | `planStates` pins the accepted state sequence and parser validation rejects missing states. |
| Fixtures include owner, safe next action, evidence source, risk category, policy disposition, and customer-safe wording. | Each parsed state carries those fields plus cost/capacity labels and proof mode. |
| Target package and proof paths are pinned. | `parseVibePlanReviewStates` rejects path drift. |
| Happy path, blocked path, stale/unknown evidence path, support handoff, accessibility notes, and proof-mode labels are covered. | `scenarioPaths`, `supportHandoff`, `accessibilityNotes`, and proof-mode validation cover each acceptance state. |
| Plan/Diff consumes accepted HOBO-577 fixtures. | `quickstartFixtureRefs` pins source issue, fixture ids, consumer, proof mode, and use notes. |
| Scope out remains hard. | `classifyPlanReviewRequest` rejects planner/matcher/apply/rollback, live cost/provider credentials, production UI, approval workflow, and proofless launch requests. |

## Architecture Evidence

- `architecture/` - protobuf data shapes and CUE constraints for the plan
  review state record.
- `architecture/pacts/` - Pact-style package boundary fixture.
- `ADR.md` - parse-don't-validate and event/projection architecture note.
