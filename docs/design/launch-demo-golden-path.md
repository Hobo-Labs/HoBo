---
type: Reference
title: "Launch Demo Golden Path"
description: "Source issue: HOBO-488."
tags: [hobo, design]
---

# Launch Demo Golden Path

Source issue: HOBO-488.

Executable proof lives in
[`src/draft/exp-proofs/dx/launch-demo-golden-path-contract`](../../src/draft/exp-proofs/dx/launch-demo-golden-path-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-488-launch-demo-golden-path`](./proofs/hobo-488-launch-demo-golden-path/README.md).

## M0 Acceptance Record

The launch demo golden path uses `snapshop` as the one launch-critical sample app and records the
proof asset checklist required before that demo can be used for public claims. The path is evidence
led: live product behavior, reference fixtures, and simulated references must be labeled separately.

## Primary Persona

| Persona | Need |
|---|---|
| App developer evaluator | Follow one reproducible path from scaffold through local run, plan, deploy evidence, and failure recovery. |

Supporting personas are the platform engineer evaluator, agent builder, and demo maintainer from the
accepted [Example Apps scope](./example-apps.md).

## Scope In

- Golden path checklist for the `snapshop` sample app.
- Setup prerequisites, command path, screens, expected outputs, and failure recovery scenarios.
- Proof-mode labels for live product behavior, reference fixtures, and simulated references.
- Required proof assets: screenshots, recording manifest, command transcript, fixture data, and docs.
- Refresh ownership for proof assets when commands, screens, outputs, or claim boundaries change.

The executable refresh-plan proof for downstream vibe examples lives in
[`src/draft/exp-proofs/ux/vibe-launch-asset-refresh-plan`](../../src/draft/exp-proofs/ux/vibe-launch-asset-refresh-plan/README.md),
with branch evidence summarized in
[`proofs/vibe-launch-asset-refresh-plan`](./proofs/vibe-launch-asset-refresh-plan/README.md).

## Scope Out And Non-Goals

- Do not build the example application in this issue.
- Do not create a launch marketing page, final copy, visual polish, screenshots, or final demo video.
- Do not provision real cloud resources, provider credentials, or production hosting.
- Do not define customer onboarding, support, billing, legal, or release go/no-go process.
- Do not claim production readiness from reference fixtures or simulated behavior.

## Command Path

| Step | Command | Screen | Proof mode | Claim boundary |
|---|---|---|---|---|
| Scaffold | `npx hobo new snapshop -t fullstack` | Terminal scaffold transcript | Reference fixture | Proves command path shape, not a shipped scaffold implementation. |
| Local run | `hobo dev` | Local runtime activity screen | Simulated reference | Shows reference local-runtime behavior until live CLI evidence exists. |
| Inspect | `hobo inspect run <run-id>` | Run inspector timeline | Reference fixture | Pins expected workflow, step, and event evidence without implementing the inspector. |
| Plan | `hobo plan --camp preview` | Plan diff and proof-mode labels | Simulated reference | Shows expected planning evidence and unsupported-state labels without provisioning. |
| Live recording slot | `hobo up --camp preview --strategy canary` | Preview deploy recording slot | Live product | Public demo may claim live behavior only when the recording manifest links accepted live evidence. |

## Required Assets

| Asset | Owner | Proof mode | Refresh trigger |
|---|---|---|---|
| Screenshots | Demo maintainer | Live product | Any screen, command wording, output, or proof-mode label changes. |
| Recording manifest | V1 Launch Site, Messaging & Demo Assets | Live product | Any live preview, expected output, or simulated/reference marker changes. |
| Command transcript | Example Apps | Reference fixture | Any command path, CLI wording, or fixture output changes. |
| Fixture data | Example Apps | Reference fixture | Any sample app, resource, manifest, or failure recovery fixture changes. |
| Docs | Example Apps | Design record | Any acceptance, owner, scope, or public-claim boundary changes. |

## Failure Recovery

- Dependency install or scaffold failure records exact failure, retry command, and docs handoff.
- Missing auth or SVID state blocks the live preview path and downgrades to reference-fixture proof.
- Policy denial or `can-deploy` failure records denial evidence and remediation owner.
- Unsupported provider or capability is labeled as unsupported and cannot be promoted to live proof.
- Stale recording fails freshness until refreshed or downgraded.

## Follow-Up Gate

Future launch-site, demo-asset, and public-copy work must consume this record. A demo asset that
lacks source, owner, refresh trigger, or proof-mode label is not ready for launch use.
