---
type: Reference
title: "HOBO-532 Closure Builder Public API Proof"
description: "Proof note for the v1 closure-builder public API contract."
tags: [hobo, proof]
---

# HOBO-532 Closure Builder Public API Proof

Source issue: HOBO-532.

This proof records that the v1 explicit Bindle contract is now the
closure-builder API in `@hobo/bindles`.

## Evidence

- Source record: [`../../closure-builder-public-api.md`](../../closure-builder-public-api.md).
- SDK contract index: [`../../sdk-contracts.md`](../../sdk-contracts.md).
- Package ownership: [`../../package-namespaces.md`](../../package-namespaces.md).
- Executable proof package:
  [`../../../../src/draft/technical-proofs/closure-builder-public-api-contract`](../../../../src/draft/technical-proofs/closure-builder-public-api-contract/README.md).
- Downstream handle proof:
  [`../hobo-533-closure-builder-resource-handles`](../hobo-533-closure-builder-resource-handles/README.md).

## Verified Assertions

- Bindle is manifest assembly, not app-host behavior.
- Imported app/framework code owns app-host behavior.
- Resource builder methods use anonymous HoBo-generated identities in v1.
- Local variables and returned object keys are aliases only.
- `dependsOn()` is the only v1 relationship verb.
- Public v1 design docs do not retain legacy explicit-resource examples.

## Gate

```powershell
npm.cmd --prefix src\draft\technical-proofs\closure-builder-public-api-contract test
```
