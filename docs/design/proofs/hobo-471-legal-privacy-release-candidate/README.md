---
type: Reference
title: "HOBO-471 Legal Privacy Release Candidate Proof"
description: "Source issue: HOBO-471."
tags: [hobo, design, proof]
---

# HOBO-471 Legal Privacy Release Candidate Proof

HOBO-471 is proven by the focused M3 contract at
[`src/draft/exp-proofs/cx/legal-privacy-release-candidate-evidence-contract`](../../../../src/draft/exp-proofs/cx/legal-privacy-release-candidate-evidence-contract/README.md)
and the durable M3 gate record in
[`legal-privacy-terms-readiness.md`](../../legal-privacy-terms-readiness.md#m3-release-candidate-evidence-gate).

## Evidence

- Required release-candidate evidence is mapped to V1 Legal, Customer Assurance,
  Compliance Evidence Pack, Support, Launch Messaging, Release Notes, and V1
  Release Program owners.
- Blockers and accepted risks remain visible as release-candidate limitations or
  GA blockers.
- Cross-project dependencies are reflected in the release cutline.
- Follow-up issues are limited to existing missing-evidence issues, currently
  `HOBO-478` for GA legal/privacy signoff.
- Parent release-readiness sync is required because the gate changes launch
  risk.
- Scope guards reject final legal text, paid GA approval, and unsupported public
  claims.

## Verification

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\legal-privacy-release-candidate-evidence-contract test
```

The branch gate also verifies this proof package's workspace registration,
package-local protobuf/CUE/Pact evidence, and repository schema compatibility
through `pnpm.cmd run install:check` and `pnpm.cmd run test:schema`.
