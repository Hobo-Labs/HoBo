---
type: Reference
title: "HOBO-432 Compatibility Matrix Proof"
description: "Source issue: HOBO-432."
tags: [hobo, design]
---

# HOBO-432 Compatibility Matrix Proof

HOBO-432 is proven by the focused M0 contract at
[`src/draft/exp-proofs/cx/compatibility-matrix-scope-contract`](../../../../src/draft/exp-proofs/cx/compatibility-matrix-scope-contract/README.md)
and the durable scope record at
[compatibility-matrix.md](../../compatibility-matrix.md).

## Acceptance Evidence

- User/business goal and primary personas are explicit.
- Scope in/out and non-goals are recorded.
- Product, UX, DX/CLI, support/release, security, and privacy boundaries are mapped.
- M1 evidence names matrix fixtures, claim mapping, and unsupported-report routing.
- Follow-up M1-M4 work is blocked until M0 acceptance.

## Negative Coverage

- Validation rejects browser-grid implementation in this M0 slice.
- Validation rejects native-mobile app or full mobile authoring creep.
- Validation rejects live e2e/performance/certification work.
- Validation rejects proofless follow-up work without the M0 gate.

## Verification

```powershell
pnpm --dir src\draft\exp-proofs\compatibility-matrix-scope-contract test
```
