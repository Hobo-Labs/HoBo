# Vibe First-Customer Pilot Storyboard

Independent M1 proof for HOBO-549.

This package records a first-customer pilot storyboard and script artifact
contract for invite, workspace setup, project choice, first proof, failure
recovery, support handoff, and feedback capture. It keeps the pilot path
customer-safe by reusing accepted HOBO-577 quickstart fixture ids and by
refusing CRM, customer-success automation, support tooling, live customer data,
production tenant mutation, provider deployment, and proofless launch claims.

## Audience

- Pilot customer champion
- Customer success lead
- Support engineer
- Release owner
- Security reviewer

## Contract Boundaries

- In scope: storyboard steps, script artifacts, stage entry/exit criteria,
  consent state, proof-mode labels, blocker category, owner route, safe next
  action, customer-safe message, accessibility notes, and scope-out guards.
- Quickstart dependency: pilot artifacts cite HOBO-577 fixture ids
  `rlq-define-object-graph-v1`, `rlq-plan-safe-preview-v1`,
  `rlq-deploy-run-accepted-v1`, `rlq-manage-stale-evidence-v1`, and
  `rlq-recover-scope-out-v1`.
- Consumed but not owned: workspace onboarding states, beta feedback routing,
  launch blocker taxonomy, launch support escalation language, and release
  cutline classification.
- Out of scope: CRM, customer-success automation, support tooling, live
  customer data, production tenant mutation, provider deployment, credentials,
  and launch claims without evidence.

## Proof

```powershell
npm.cmd --prefix src\draft\exp-proofs\vibe-first-customer-pilot-storyboard test
```

## Acceptance Map

| Acceptance | Evidence |
|---|---|
| Storyboard covers pilot customer champion, customer success lead, support engineer, release owner, and security reviewer roles. | `storyboard` maps every required persona to stage-specific operating questions. |
| Script artifacts include stage, entry/exit criteria, consent state, proof mode, blocker category, owner, safe next action, and customer-safe message. | `scriptArtifacts` carry those fields per stage and parser tests reject missing metadata. |
| Target package and proof paths are pinned. | `parseVibeFirstCustomerPilotStoryboard` rejects path drift. |
| Happy, blocked, stale/unknown, support handoff, accessibility, and proof-mode labels are covered. | `scenarioPaths`, `accessibilityNotes`, and proof-mode validation cover each state. |
| Downstream pilot story consumes accepted HOBO-577 quickstart fixtures. | `quickstartFixtureRefs` pins source issue, accepted fixture ids, and pilot-use notes. |
| Scope out remains hard. | `classifyPilotStoryboardRequest` rejects CRM, automation, support tooling, live customer data, production tenant mutation, provider deployment, and proofless launch claims. |

## Architecture Evidence

- `architecture/` - protobuf data shapes and CUE constraints for the pilot
  storyboard record.
- `architecture/pacts/` - Pact-style package boundary fixture.
- `ADR.md` - parse-don't-validate and event/projection architecture note.
