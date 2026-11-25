---
type: Reference
title: "HOBO-536 Closure Builder Tooling Proof"
description: "Proof note for closure-builder collection coverage, collect, codegen, and scaffold handling."
tags: [hobo, proof]
---

# HOBO-536 Closure Builder Tooling Proof

Source issue: HOBO-536.

This proof records that closure-builder aliases feed the normal authoring
tooling path without becoming resource identities.

## Evidence

- Source record: [`../../closure-builder-public-api.md`](../../closure-builder-public-api.md).
- SDK contract index: [`../../sdk-contracts.md`](../../sdk-contracts.md).
- Upstream public API proof:
  [`../hobo-532-closure-builder-public-api`](../hobo-532-closure-builder-public-api/README.md).
- Upstream resource-handle proof:
  [`../hobo-533-closure-builder-resource-handles`](../hobo-533-closure-builder-resource-handles/README.md).
- Executable proof package:
  [`../../../../src/draft/technical-proofs/closure-builder-tooling-contract`](../../../../src/draft/technical-proofs/closure-builder-tooling-contract/README.md).

## Verified Assertions

- Static coverage recognizes closure-builder resources from returned aliases.
- `hobo collect` proof data lowers closure-builder resources to
  `hobo.manifest/v1` using generated IDs.
- `hobo codegen` emits typed bindings keyed by returned aliases without treating
  aliases as resource IDs.
- `hobo new` scaffold proof emits the canonical closure-builder sample.
- Unobserved closure-builder resources fail closed with diagnostics.

## Gate

```powershell
npm.cmd --prefix src\draft\technical-proofs\closure-builder-tooling-contract test
```
