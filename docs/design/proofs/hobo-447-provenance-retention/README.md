---
type: Reference
title: "HOBO-447 Provenance & Retention M0 Scope Proof"
description: "Source issue: HOBO-447."
tags: [hobo, design]
---

# HOBO-447 Provenance & Retention M0 Scope Proof

HOBO-447 is proven by the focused M0 contract at
[`src/draft/exp-proofs/dx/provenance-retention-scope-acceptance`](../../../../src/draft/exp-proofs/dx/provenance-retention-scope-acceptance/README.md)
and the durable scope record at [provenance-retention.md](../../provenance-retention.md).

## Acceptance Evidence

- Goal and personas are explicit for release engineers, security reviewers, compliance leads,
  support operators, and customer admins.
- Scope in, scope out, non-goals, and service/UX/security/support boundaries are recorded.
- Dependencies map to Plan 46, Plan 25, Plan 29, ADR-0062, ADR-0073, ADR-0046, and ADR-0023.
- Owning initiative dependencies map Provenance, Release Channels, Compatibility Matrix, Upgrade
  Test Suite, Backup & Restore, Capability Review & Approval, Audit Explorer, and Support & Debug
  Tools consumption without taking their scope.
- M1 evidence is listed as artifact provenance schema, retention policy matrix, audit export
  fixture, support debug handoff, yank invalidation playbook, and customer assurance summary.
- Follow-up M1-M4 issues are blocked until M0 acceptance is recorded.

## Negative Coverage

- Scope validation rejects artifact-store, signing-key, KMS, SLSA signer, live-registry, registry
  crawler, or legal-retention implementation creep inside M0.
- Assurance validation rejects customer-visible claims without a named evidence source.
- Follow-up gating refuses M1-M4 issue creation while M0 is not accepted.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\provenance-retention-scope-acceptance test
```
