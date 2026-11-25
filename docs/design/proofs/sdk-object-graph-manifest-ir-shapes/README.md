---
type: Reference
title: "HOBO-568 SDK Object Graph Manifest IR Shapes Proof"
description: "Proof note for SDK-facing @hobo/bindles object graph and manifest IR examples."
tags: [hobo, proof, dx, sdk]
---

# HOBO-568 SDK Object Graph Manifest IR Shapes Proof

Source issue: HOBO-568.

This proof records the SDK-facing example consumer shapes for
`@hobo/bindles`, generated `hobo:sdk` bindings, `hobo.manifest/v1`, typed
DeploymentPlan and migration-plan request fixtures, and inspect/log subscription
reader examples.

## Evidence

- Executable package:
  [`sdk-object-graph-manifest-ir-shapes`](../../../../src/draft/exp-proofs/api/sdk-object-graph-manifest-ir-shapes/README.md).
- SDK/API source:
  [`sdk-api.md`](../../sdk-api.md#plan-02),
  [`sdk-contracts.md`](../../sdk-contracts.md), and
  [`closure-builder-public-api.md`](../../closure-builder-public-api.md).
- DX and lifecycle source:
  [`developer-experience.md`](../../developer-experience.md#plan-07),
  [`control-plane.md`](../../control-plane.md#plan-04),
  [`platform-engineering.md`](../../platform-engineering.md#plan-25), and
  [`data-plane.md`](../../data-plane.md#plan-32).

## Verified Assertions

- SDK examples remain interface-only and compile/typecheck against the intended
  `@hobo/bindles` shape.
- Generated binding names lower to `hobo:sdk/*` and `hobo.manifest/v1`.
- A local `tsc --noEmit` consumer typechecks the SDK object graph, generated WIT
  binding refs, manifest IR, resource refs, and typed plan/migration/read calls.
- Desired resources, provider/capability refs, DeploymentPlan requests,
  migration-plan requests, and inspect/log readers all have deterministic
  fixture ids, inputs, and outputs.
- `.raw()` and authoritative-external resources are visible debt, not hidden SDK
  magic.
- Publishing a real SDK package, generating production bindings, calling live
  cloud providers, using real credentials, or adding SDK semantics beyond the
  WIT-first thin idiom layer is rejected as scope creep.

## Gate

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\sdk-object-graph-manifest-ir-shapes test
```
