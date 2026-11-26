---
type: Design Proof Evidence
title: "HOBO-552 Vibe Role Tutorial Outlines Proof"
description: "M1 proof record for six role tutorial outlines and fixture-backed evidence paths."
tags: [hobo, proof, tutorials, walkthroughs, vibe]
timestamp: 2026-07-01T00:00:00Z
---

# HOBO-552 Vibe Role Tutorial Outlines Proof

This proof records branch evidence for app developer, platform engineer,
GitOps, SecOps, DevOps, and SRE tutorial outlines that are runnable-proof ready
without becoming final tutorial content.

## Evidence

- Source record: [`tutorials-walkthroughs.md`](../../tutorials-walkthroughs.md).
- Role source: [`walkthrough.md`](../../walkthrough.md).
- Quickstart source: [`resource-lifecycle-quickstart-examples`](../resource-lifecycle-quickstart-examples/README.md).
- DX matrix source: [`dx-resource-lifecycle-scenario-matrix`](../dx-resource-lifecycle-scenario-matrix/README.md).
- Executable proof: [`vibe-role-tutorial-outlines`](../../../../src/draft/exp-proofs/ux/vibe-role-tutorial-outlines/README.md).

## Acceptance Coverage

| Acceptance | Proof |
|---|---|
| Each tutorial outline includes persona goal, prerequisites, command path, fixture strategy, expected outputs, failure branch, and proof-mode labels. | `test/vibe-role-tutorial-outlines.test.ts` asserts every role outline carries those fields. |
| Outlines map to existing role walkthrough and CLI/MCP surfaces without inventing new lifecycle verbs. | Tests require `walkthrough.md` anchors, canonical `hobo` or `git push` command paths, and MCP tool names. |
| Package and proof path match the issue. | `parseVibeRoleTutorialOutlines` rejects path drift from the target package and proof path. |
| Happy path, blocked path, stale/unknown evidence path, support handoff, accessibility notes, and proof-mode labels are covered. | `coveragePaths`, accessibility notes, proof-mode validation, and HOBO-577 deploy/inspect/recovery fixture checks cover each required state and label. |
| Quickstart fixtures remain the accepted source for tutorial examples. | `quickstartFixtureRefs` pins the accepted HOBO-577 define, collect, plan, deploy, inspect, manage, migrate, recovery, and scope-out fixture ids with proof-mode labels. |

## Adversarial Evidence

The parser and tests reject requests that try to turn this proof into final
tutorial content, live provider execution, hosted docs implementation,
production recordings, customer data, or launch claims without evidence.

## Verification

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\vibe-role-tutorial-outlines test
```
