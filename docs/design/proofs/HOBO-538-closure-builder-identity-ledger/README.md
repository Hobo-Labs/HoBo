---
type: Reference
title: "HOBO-538 Closure Builder Identity Ledger Proof"
description: "Proof note for collector-owned generated identity ledgers across same-kind closure-builder insertions."
tags: [hobo, proof]
---

# HOBO-538 Closure Builder Identity Ledger Proof

Source issue: HOBO-538.

This proof records the accepted requirement for ambiguous same-kind insertion
edits in closure-builder authoring. The public builder remains anonymous:
resource factory methods still take no resource-name arguments, and aliases do
not become deployment identity.

## Ledger Contract

- Owner: HoBo collector artifact.
- Update flow: `collector-proposes-review-accepts`.
- Review boundary: code review before downstream manifest lowering consumes the
  artifact.
- Matching key: resource kind plus same-kind occurrence in the collected
  closure.
- Identity value: HoBo-generated `res_<kind>_<ordinal>` IDs only.
- Explicitly rejected: local variable aliases, returned object keys, physical
  name seeds, and user-supplied factory names.

## Evidence

- Source record: [`../../closure-builder-public-api.md`](../../closure-builder-public-api.md).
- SDK contract index: [`../../sdk-contracts.md`](../../sdk-contracts.md).
- Executable proof package:
  [`../../../../src/draft/technical-proofs/closure-builder-resource-handles-contract`](../../../../src/draft/technical-proofs/closure-builder-resource-handles-contract/README.md).

## Verified Assertions

- Inserting a same-kind resource before an existing same-kind resource does not
  churn the existing generated ID when the collector-owned ledger has a reviewed
  mapping.
- The ledger parser rejects alias-derived identity, returned-key identity,
  physical-name identity, and non-collector-owned artifacts.
- The presence of a ledger does not re-enable public resource-name factory
  arguments.
- Diagnostics still display alias and generated ID separately, with physical
  name seeds derived from `bindle:generatedId`.

## Scope Boundary

The proof does not implement manifest lowering, provider runtime persistence,
codegen, collection coverage, or end-to-end author flow. HOBO-535 through
HOBO-537 consume the accepted ledger requirement when those downstream proof
surfaces lower and present closure-builder resources.

## Gate

```powershell
corepack pnpm -C src\draft\technical-proofs\closure-builder-resource-handles-contract test
```
