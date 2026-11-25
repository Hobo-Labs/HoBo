---
type: Reference
title: "HOBO-531 Closure Builder V1 Finalization Proof"
description: "Proof note for the accepted closure-builder v1 public API finalization gate."
tags: [hobo, proof]
---

# HOBO-531 Closure Builder V1 Finalization Proof

HOBO-531 closes the parent closure-builder `@hobo/bindles` v1 API item after
the accepted child and RCR evidence has landed.

## Evidence

- Canonical public API record:
  [`closure-builder-public-api.md`](../../closure-builder-public-api.md).
- Finalization contract:
  [`closure-builder-v1-finalization-contract`](../../../../src/draft/technical-proofs/closure-builder-v1-finalization-contract/README.md).
- Child/RCR proof set: HOBO-532, HOBO-533, HOBO-534, HOBO-535, HOBO-536,
  HOBO-537, and HOBO-538.

## Acceptance

- Every closure-builder child/RCR evidence record is Done.
- V1 docs lead with `bindle(name, builderFn)` from `@hobo/bindles`.
- `dependsOn()` remains the only v1 relationship verb.
- Local variables and returned object keys remain aliases, not deployment
  identity.
- Pre-v1 `b.use(database("db"))` explicit-Bindle examples are not accepted as
  compatibility requirements.

## Verification

```powershell
corepack pnpm -C src\draft\technical-proofs\closure-builder-v1-finalization-contract test
```
