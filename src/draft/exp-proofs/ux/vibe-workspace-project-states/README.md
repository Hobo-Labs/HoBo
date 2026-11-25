# Vibe workspace/project states

This package proves `HOBO-541`: workspace/project empty, ready, blocked,
recovering, failed, and value-proven states for the v1 vibe onboarding surface.

It is an experience proof over deterministic fixtures. It does not build the
dashboard, account service, auth flow, billing flow, live provider path,
customer-data surface, or launch claim machinery.

## Contract shape

Each state fixture records:

- workspace and project summaries
- provider-readiness status and blocker owner
- safe next action and required evidence
- evidence link, freshness, and proof-mode label
- support handoff and redaction rule
- accessibility notes
- wireframe regions for mockup review

The proof modes are `live`, `simulated`, `reference fixture`, and `scope-out`.
The `live` label means accepted live evidence must exist elsewhere before a
future surface may use it; this proof never calls a live provider.

## Contract anchors

- Protobuf: `architecture/vibe_workspace_project_states.proto`
- CUE constraints: `architecture/vibe_workspace_project_states.cue`
- Pact-style fixture: `architecture/pacts/vibe_workspace_project_states.pact.json`
- Executable acceptance: `test/vibe-workspace-project-states.test.ts`

## Acceptance mapping

| Acceptance requirement | Branch evidence |
| --- | --- |
| Mockups/wireframes cover empty, ready, blocked, recovering, failed, and value-proven states. | `WORKSPACE_PROJECT_STATES` and `listWorkspaceProjectWireframes` require one wireframe record per state. |
| Deterministic fixture records workspace, project, provider-readiness, blocker owner, safe next action, and evidence link fields. | `WorkspaceProjectStateFixture` and parser assertions require those fields for every row. |
| Target package and proof note paths are fixed. | Parser requires `src/draft/exp-proofs/ux/vibe-workspace-project-states` and `docs/design/proofs/vibe-workspace-project-states/README.md`. |
| Covers happy path, blocked path, stale/unknown evidence, support handoff, accessibility notes, and proof modes. | `REQUIRED_JOURNEY_COVERAGE`, `REQUIRED_PROOF_MODES`, fixture coverage, and tests prove those sets. |
| Adversarial scope-out stays explicit. | `classifyWorkspaceProjectStateScope` rejects live providers, customer data, launch claims, account/auth/billing, and production UI. |

## Verification

```bash
pnpm run test:file src/draft/exp-proofs/ux/vibe-workspace-project-states/test/vibe-workspace-project-states.test.ts
```
