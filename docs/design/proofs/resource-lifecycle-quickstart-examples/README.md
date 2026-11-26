---
type: Reference
title: "Resource Lifecycle Quickstart Examples Proof"
description: "Source issue: HOBO-577."
tags: [hobo, design]
---

# Resource lifecycle quickstart examples proof

`HOBO-577` creates the canonical resource lifecycle quickstart example set for
docs, tutorials, launch-demo, workspace, plan/diff, and dashboard consumers.
The executable proof lives in
`src/draft/exp-proofs/dx/resource-lifecycle-quickstart-examples`.

## Acceptance evidence

| Acceptance requirement | Branch evidence |
| --- | --- |
| Produces docs-ready snippets for SDK code, CLI commands, API/MCP equivalents, fixture ids, proof-mode labels, and safe claims. | `RESOURCE_LIFECYCLE_QUICKSTART_EXAMPLES.steps` carries SDK, CLI, API, and MCP snippets for every phase; the parser and tests require `fixtureId`, `proofMode`, and `safeClaim` on each snippet. |
| Quickstart explicitly says which parts are reference fixtures, simulated, live, or scope-out. | `QUICKSTART_PROOF_MODES` and `modeNotes` define `reference-fixture`, `simulated`, `live`, and `scope-out`; tests assert every mode is present. |
| Includes deploy/manage/migrate paths and does not replace them with enterprise dashboard tours. | The phase list includes `deploy`, `manage`, `migrate`, and `recover`; `classifyQuickstartScope` rejects enterprise dashboard feature tours. |
| Provides handoff notes for Docs Portal, Tutorials, Troubleshooting, Launch Site, Workspace UX, Plan/Diff, and Dashboard consumers. | `QUICKSTART_CONSUMERS` and `handoffs` require all seven downstream consumers, fixture ids, handoff notes, and `mustNotClaim` guardrails. |
| Respects scope-out for unbacked marketing, customer promises, live credentials, production docs publication, and enterprise UI walkthroughs. | `scopeOut`, `safeClaims`, and `classifyQuickstartScope` fail closed for those cases. |

## Fixture ids

- `rlq-define-object-graph-v1`
- `rlq-collect-manifest-ir-v1`
- `rlq-plan-safe-preview-v1`
- `rlq-deploy-run-accepted-v1`
- `rlq-inspect-event-projection-v1`
- `rlq-manage-stale-evidence-v1`
- `rlq-migrate-brownfield-preview-v1`
- `rlq-recover-snapshot-restore-v1`
- `rlq-recover-scope-out-v1`

## Verification

```bash
pnpm run test:file src/draft/exp-proofs/dx/resource-lifecycle-quickstart-examples/test/resource-lifecycle-quickstart-examples.test.ts
```

Architecture and boundary artifacts:

- Protobuf: `src/draft/exp-proofs/dx/resource-lifecycle-quickstart-examples/architecture/resource_lifecycle_quickstart_examples.proto`
- CUE: `src/draft/exp-proofs/dx/resource-lifecycle-quickstart-examples/architecture/resource_lifecycle_quickstart_examples.cue`
- Pact-style fixture: `src/draft/exp-proofs/dx/resource-lifecycle-quickstart-examples/architecture/pacts/resource_lifecycle_quickstart_examples.pact.json`
