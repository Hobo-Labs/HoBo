# Vibe Role Tutorial Outlines

Independent M1 proof for HOBO-552.

This package records runnable-proof-ready tutorial outlines for the app
developer, platform engineer, GitOps, SecOps, DevOps, and SRE journeys. It
keeps each outline tied to the accepted role walkthrough, canonical CLI/MCP
surfaces, HOBO-577 quickstart fixture ids, proof-mode labels, accessibility
notes, and support handoffs without writing final tutorial content or touching
live services.

## Contract Boundaries

- In scope: tutorial outline records, persona goals, prerequisites, command
  paths, fixture strategy, expected outputs, failure branches, proof-mode
  labels, accessibility notes, support handoffs, protobuf/CUE/Pact artifacts,
  and fail-closed scope guards.
- Quickstart dependency: outlines cite HOBO-577 fixture ids
  `rlq-define-object-graph-v1`, `rlq-collect-manifest-ir-v1`,
  `rlq-plan-safe-preview-v1`, `rlq-deploy-run-accepted-v1`,
  `rlq-inspect-event-projection-v1`, `rlq-manage-stale-evidence-v1`,
  `rlq-migrate-brownfield-preview-v1`, `rlq-recover-snapshot-restore-v1`,
  and `rlq-recover-scope-out-v1`.
- Consumed but not owned: Tutorials & Walkthroughs scope, role walkthrough,
  worked example, Developer Experience, resource lifecycle quickstart, DX
  scenario matrix, and CLI/MCP parity records.
- Out of scope: final tutorial content, live provider execution, hosted docs
  implementation, production recordings, customer data, and launch claims
  without evidence.

## Proof

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\vibe-role-tutorial-outlines test
```

## Acceptance Map

| Acceptance | Evidence |
|---|---|
| Each tutorial outline includes persona goal, prerequisites, command path, fixture strategy, expected outputs, failure branch, and proof-mode labels. | `VIBE_ROLE_TUTORIAL_OUTLINES.outlines` carries each field; `parseVibeRoleTutorialOutlines` rejects missing fields. |
| Outlines map to existing role walkthrough and CLI/MCP surfaces without inventing lifecycle verbs. | Each outline has a `walkthroughAnchor`, canonical `hobo` or `git push` commands, and MCP tool names. |
| Target package and proof paths are pinned. | Parser rejects drift from `src/draft/exp-proofs/ux/vibe-role-tutorial-outlines` and `docs/design/proofs/vibe-role-tutorial-outlines/README.md`. |
| Happy path, blocked path, stale/unknown evidence path, support handoff, accessibility notes, and proof-mode labels are covered. | `coveragePaths`, outline accessibility notes, proof-mode validation, and HOBO-577 deploy/inspect/recovery fixture checks cover the accepted states and labels. |
| Scope out remains hard. | `classifyRoleTutorialRequest` rejects final tutorial content, live provider execution, hosted docs implementation, production recordings, customer data, and proofless launch claims. |

## Architecture Evidence

- `architecture/` - protobuf data shapes and CUE constraints for the parsed
  tutorial outline record. CUE uses lower-camel field names matching the
  TypeScript boundary.
- `architecture/pacts/` - Pact-style package boundary fixture that parses
  through `parseVibeRoleTutorialOutlines`.
- `ADR.md` - parse-don't-validate and event/projection architecture note.
