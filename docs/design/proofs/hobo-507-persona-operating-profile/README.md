---
type: Reference
title: "HOBO-507 Persona Operating Profile Proof"
description: "Source issue: HOBO-507."
tags: [hobo, design]
---

# HOBO-507 Persona Operating Profile Proof

HOBO-507 is proven by the focused M0 contract at
[`src/draft/technical-proofs/persona-operating-profile-contract`](../../../../src/draft/technical-proofs/persona-operating-profile-contract/README.md)
and the durable scope record at
[`persona-operating-profile.md`](../../persona-operating-profile.md).

## Acceptance Evidence

- Minimal profile fields cover industry, team type, approved systems, blocked systems, risk posture,
  approval owner, cost cap, safe-test depth, existing workflows, primary outcomes, and explicit
  do-not-do boundaries.
- Every field maps to personas, onboarding defaults, safe-test packs, approval defaults, cost caps,
  workspace settings, and first-run telemetry.
- Privacy rights cover purpose minimization, retention, edit/delete, export redaction, and tenant
  boundaries.
- Recommendation memory is defined as tenant-workspace profile facts plus derived recommendation
  decisions for v1, with post-v1 boundaries called out.
- QUI-91 remains the source evidence; this proof does not copy the full competitive-extension
  implementation backlog.

## Negative Coverage

- Scope validation rejects ML personalization, broad behavioral tracking, and cross-tenant
  recommendation memory.
- Launch recommendation claims fail closed when required recommendation uses, QUI-91 source
  evidence, tenant-workspace scope, or contract-record evidence mode are missing.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\persona-operating-profile-contract test
```
