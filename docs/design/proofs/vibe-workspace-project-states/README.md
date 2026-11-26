---
type: Reference
title: "Vibe Workspace Project States Proof"
description: "Source issue: HOBO-541."
tags: [hobo, design]
---

# Vibe workspace/project states proof

`HOBO-541` proves deterministic workspace/project states for the v1 vibe
onboarding surface. The executable proof lives in
`src/draft/exp-proofs/ux/vibe-workspace-project-states`.

## Acceptance evidence

| Acceptance requirement | Branch evidence |
| --- | --- |
| Cover empty, ready, blocked, recovering, failed, and value-proven mockups/wireframes. | `WORKSPACE_PROJECT_STATES` and `listWorkspaceProjectWireframes` require one wireframe fixture per state with status, evidence, and safe-action regions. |
| Record workspace, project, provider-readiness, blocker owner, safe next action, and evidence link fields. | `WorkspaceProjectStateFixture` and parser assertions require every fixture to carry these fields. |
| Use the target package and proof note paths. | Parser requires `src/draft/exp-proofs/ux/vibe-workspace-project-states` and this proof note path. |
| Cover happy, blocked, stale/unknown evidence, support handoff, accessibility notes, and proof modes. | `REQUIRED_JOURNEY_COVERAGE`, `REQUIRED_PROOF_MODES`, fixture rows, and tests prove coverage. |
| Respect scope-out for account/auth/billing, dashboard implementation, live providers, customer data, and launch claims. | `classifyWorkspaceProjectStateScope` fails closed for those requests. |

## Fixture states

- `empty`: no project yet; start from a reference fixture.
- `ready`: plan preview is available through simulated evidence.
- `blocked`: provider approval evidence is missing and owner is named.
- `recovering`: stale recovery evidence routes to support handoff.
- `failed`: unknown evidence refuses success wording and opens a redacted support bundle.
- `value-proven`: accepted evidence link is present; future live proof remains separately gated.

## Verification

```bash
pnpm run test:file src/draft/exp-proofs/ux/vibe-workspace-project-states/test/vibe-workspace-project-states.test.ts
```

Architecture and boundary artifacts:

- Protobuf: `src/draft/exp-proofs/ux/vibe-workspace-project-states/architecture/vibe_workspace_project_states.proto`
- CUE: `src/draft/exp-proofs/ux/vibe-workspace-project-states/architecture/vibe_workspace_project_states.cue`
- Pact-style fixture: `src/draft/exp-proofs/ux/vibe-workspace-project-states/architecture/pacts/vibe_workspace_project_states.pact.json`
