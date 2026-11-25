---
type: Reference
title: "HOBO-534 Closure Builder Generated Identity Proof"
description: "Proof note for stable generated resource IDs and alias separation in closure-builder authoring."
tags: [hobo, proof]
---

# HOBO-534 Closure Builder Generated Identity Proof

Source issue: HOBO-534.

This proof records that closure-builder resource identity is HoBo-generated and
separate from local author aliases.

## Evidence

- Source record: [`../../closure-builder-public-api.md`](../../closure-builder-public-api.md).
- SDK contract index: [`../../sdk-contracts.md`](../../sdk-contracts.md).
- Executable proof package:
  [`../../../../src/draft/technical-proofs/closure-builder-resource-handles-contract`](../../../../src/draft/technical-proofs/closure-builder-resource-handles-contract/README.md).

## Verified Assertions

- Renaming local aliases does not churn existing generated IDs.
- Reordering returned keys does not churn existing generated IDs.
- Inserting another resource kind does not churn existing generated IDs.
- Diagnostics display alias, generated ID, resource kind, owner Bindle, and
  physical-name seed as separate fields.
- Physical-name seeds derive from `bindle:generatedId`, not aliases.

## Scope Boundary

The proof does not introduce user-supplied resource names, alias-derived
physical names, manifest lowering, codegen, collection coverage, or runtime
provider behavior. Ambiguous same-kind insertions are accepted by HOBO-538's
collector-owned identity ledger proof instead of this alias-only stability
slice.

## Gate

```powershell
corepack pnpm -C src\draft\technical-proofs\closure-builder-resource-handles-contract test
```
