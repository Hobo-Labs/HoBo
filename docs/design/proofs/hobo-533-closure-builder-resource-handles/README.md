---
type: Reference
title: "HOBO-533 Closure Builder Resource Handles Proof"
description: "Proof note for anonymous builder resource handles and dependsOn relationships."
tags: [hobo, proof]
---

# HOBO-533 Closure Builder Resource Handles Proof

Source issue: HOBO-533.

This proof records that the v1 closure-builder API can create anonymous resource
handles and record `dependsOn()` relationships without starting app-host code.

## Evidence

- Source record: [`../../closure-builder-public-api.md`](../../closure-builder-public-api.md).
- SDK contract index: [`../../sdk-contracts.md`](../../sdk-contracts.md).
- Executable proof package:
  [`../../../../src/draft/technical-proofs/closure-builder-resource-handles-contract`](../../../../src/draft/technical-proofs/closure-builder-resource-handles-contract/README.md).

## Verified Assertions

- Type fixture proves closure-builder authoring compiles.
- Named resource arguments fail at compile time and runtime.
- Invalid dependencies fail with stable error codes.
- Workload factories remain inert descriptors.
- `dependsOn()` emits a manifest-lowering relationship.
- Provider `.with(...)` annotations remain inert resource annotations.

## Gate

```powershell
npm.cmd --prefix src\draft\technical-proofs\closure-builder-resource-handles-contract test
```
