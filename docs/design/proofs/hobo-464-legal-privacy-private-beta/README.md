---
type: Reference
title: "HOBO-464 Legal Privacy Private Beta Proof"
description: "Source issue: HOBO-464."
tags: [hobo, design, proof]
---

# HOBO-464 Legal Privacy Private Beta Proof

HOBO-464 is proven by the focused M2 contract at
[`src/draft/exp-proofs/cx/legal-privacy-private-beta-evidence-contract`](../../../../src/draft/exp-proofs/cx/legal-privacy-private-beta-evidence-contract/README.md)
and the durable M2 gate record in
[`legal-privacy-terms-readiness.md`](../../legal-privacy-terms-readiness.md#m2-private-beta-evidence-gate).

## Evidence

- Required private beta evidence is mapped to V1 Legal, Customer Assurance,
  Compliance Evidence Pack, Support, Security Verification, and V1 Release
  Program owners.
- Blockers and accepted risks remain visible as beta limitations or
  release-candidate/GA blockers.
- Cross-project dependencies are reflected in the release cutline.
- Follow-up issues are limited to existing missing-evidence issues:
  `HOBO-471` and `HOBO-478`.
- Parent release-readiness sync is required because the gate changes launch
  risk.

## Verification

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\legal-privacy-private-beta-evidence-contract test
```

The branch gate also verifies this proof package's workspace registration and
generated data-model catalog through `pnpm.cmd run install:check` and
`pnpm.cmd test:schema`.
