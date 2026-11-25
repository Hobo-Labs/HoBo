---
type: Reference
title: "Vibe Snapshop Launch Demo Storyboard Proof"
description: "Source issue: HOBO-555."
tags: [hobo, design]
---

# Vibe Snapshop Launch Demo Storyboard Proof

`HOBO-555` creates a deterministic `snapshop` launch-demo storyboard and
proof-mode asset map. The executable proof lives in
`src/draft/exp-proofs/ux/vibe-snapshop-launch-demo-storyboard`.

## Acceptance Evidence

| Acceptance requirement | Branch evidence |
| --- | --- |
| Storyboard covers scaffold, local run, inspect, plan, live recording slot, failure recovery, and support/docs handoff. | `REQUIRED_SNAPSHOP_STORY_STEPS` and `storyboardSteps` require all seven steps, each with command/surface, evidence object, owner, safe claim, handoff route, and accepted HOBO-577 fixture citation. |
| Asset map names screenshots, recording manifest, command transcript, fixture data, docs, owner, refresh trigger, and proof mode. | `REQUIRED_SNAPSHOP_ASSETS` and `assetMap` require all five asset kinds plus source, owner, proof mode, refresh trigger, validation route, and stale downgrade. |
| Target package path is `src/draft/exp-proofs/ux/vibe-snapshop-launch-demo-storyboard`. | Parser and tests assert the package path. |
| Target proof path is `docs/design/proofs/vibe-snapshop-launch-demo-storyboard/README.md`. | Parser and tests assert the proof path. |
| Covers happy path, blocked path, stale/unknown evidence path, support handoff, accessibility notes, and proof-mode labels. | `scenarioPaths`, `accessibilityNotes`, and tests require `happy-path`, `blocked-path`, `stale-or-unknown-evidence`, and `support-handoff`, plus live/simulated/reference fixture/scope-out labels. |

## HOBO-577 Fixture Reuse

The storyboard consumes the accepted quickstart fixtures without inventing local
ids:

- `rlq-define-object-graph-v1`
- `rlq-collect-manifest-ir-v1`
- `rlq-plan-safe-preview-v1`
- `rlq-deploy-run-accepted-v1`
- `rlq-inspect-event-projection-v1`
- `rlq-manage-stale-evidence-v1`
- `rlq-recover-snapshot-restore-v1`
- `rlq-recover-scope-out-v1`

## Asset Map

| Asset | Owner | Proof mode | Refresh trigger |
| --- | --- | --- | --- |
| Screenshots | V1 Launch Site, Messaging & Demo Assets | Live | Screen, command wording, output, or proof-mode label changes. |
| Recording manifest | V1 Launch Site, Messaging & Demo Assets | Live | Live preview, expected output, simulated marker, or recording slot changes. |
| Command transcript | Example Apps | Reference fixture | Command path, CLI wording, fixture output, or safe-claim boundary changes. |
| Fixture data | Example Apps | Reference fixture | Sample app, resource, manifest, failure, or recovery fixture changes. |
| Docs | Example Apps | Reference fixture | Acceptance, owner, scope, proof mode, or public-claim boundary changes. |

## Verification

```bash
pnpm --dir src/draft/exp-proofs/ux/vibe-snapshop-launch-demo-storyboard test
```

Architecture and boundary artifacts:

- Protobuf: `src/draft/exp-proofs/ux/vibe-snapshop-launch-demo-storyboard/architecture/proto/vibe_snapshop_launch_demo_storyboard.proto`
- CUE: `src/draft/exp-proofs/ux/vibe-snapshop-launch-demo-storyboard/architecture/vibe_snapshop_launch_demo_storyboard.cue`
- Pact-style fixture: `src/draft/exp-proofs/ux/vibe-snapshop-launch-demo-storyboard/architecture/pacts/vibe_snapshop_launch_demo_storyboard.pact.json`
