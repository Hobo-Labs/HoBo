---
type: Reference
title: "HOBO-457 Legal Privacy Terms Dogfood Alpha Proof"
description: "Source issue: HOBO-457."
tags: [hobo, design]
---

# HOBO-457 Legal Privacy Terms Dogfood Alpha Proof

HOBO-457 is proven by the focused M1 contract at
[`src/draft/technical-proofs/legal-privacy-terms-dogfood-alpha-evidence`](../../../../src/draft/technical-proofs/legal-privacy-terms-dogfood-alpha-evidence/README.md)
and the durable scope record at
[legal-privacy-terms-readiness.md](../../legal-privacy-terms-readiness.md#m1-dogfoodalpha-evidence-gate).

## Acceptance Evidence

- Required M1 evidence covers terms, privacy notice, data retention, telemetry,
  subprocessors/provider claims, security claims, support obligations, and customer communications.
- Every evidence item names the owning project and release cutline reference.
- Blockers and accepted risks are represented explicitly in the gate model.
- Cross-project dependencies are mirrored into the release cutline.
- Parent HoBo v1 Release Readiness status is represented by a gate update.
- Follow-up execution issues are allowed only when evidence is missing.
- Milestone completion is allowed only when evidence is accepted and no open blockers remain.

## Negative Coverage

- Missing evidence without a follow-up issue is rejected.
- Accepted evidence with a follow-up issue is rejected.
- Final legal text drafting is rejected.
- Unsupported paid/public launch claims are rejected.

## Verification

```powershell
pnpm.cmd --dir src\draft\technical-proofs\legal-privacy-terms-dogfood-alpha-evidence test
```
