---
type: Reference
title: "Vibe Launch Asset Refresh Plan Proof"
description: "Source issue: HOBO-556."
tags: [hobo, design]
---

# Vibe Launch Asset Refresh Plan Proof

Source issue: HOBO-556.

Executable proof:
[`src/draft/exp-proofs/ux/vibe-launch-asset-refresh-plan`](../../../../src/draft/exp-proofs/ux/vibe-launch-asset-refresh-plan/README.md).

## Acceptance Mapping

| Acceptance | Evidence |
|---|---|
| Plan names every asset, source owner, proof mode, freshness rule, refresh trigger, validation route, and stale-asset downgrade behavior. | `VIBE_LAUNCH_ASSET_REFRESH_PLAN.assets` plus package tests. |
| Fixture examples distinguish live product, simulated reference, reference fixture, and scope-out assets. | `fixtureExamples` covers `live`, `simulated`, `reference fixture`, and `scope-out`. |
| Target package path is `src/draft/exp-proofs/ux/vibe-launch-asset-refresh-plan`. | Package path and parser assertion. |
| Target proof path is `docs/design/proofs/vibe-launch-asset-refresh-plan/README.md`. | This proof note and parser assertion. |
| Covers happy path, blocked path, stale/unknown evidence path, support handoff, accessibility notes, and proof-mode labels. | `scenarios` covers all required scenario kinds with support and accessibility fields. |

## Scope Boundary

This proof does not create final marketing assets, record demo video, call live providers, use
customer data, publish a launch page, or promote unsupported public claims. Those requests are
rejected by the scope guard and must become separate owner-routed work.

## Proof Command

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\vibe-launch-asset-refresh-plan test
```
