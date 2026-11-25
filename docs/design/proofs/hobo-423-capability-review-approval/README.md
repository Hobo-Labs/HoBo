---
type: Reference
title: "HOBO-423 Capability Review & Approval M0 Scope Proof"
description: "Source issue: HOBO-423."
tags: [hobo, design]
---

# HOBO-423 Capability Review & Approval M0 Scope Proof

HOBO-423 is proven by the focused M0 contract at
[`src/draft/exp-proofs/cx/capability-review-approval-scope`](../../../../src/draft/exp-proofs/cx/capability-review-approval-scope/README.md)
and the durable scope record at
[capability-review-approval.md](../../capability-review-approval.md).

## Acceptance Evidence

- User/business goal names capability review and approval as a Productization M0 scope record.
- Primary personas cover marketplace operator, security reviewer, platform engineer, publisher
  owner, and support operator needs.
- Scope-in lists review states, approval outcomes, trust-tier evidence, security/conformance
  handoffs, rating-signal boundaries, and M1-ready evidence.
- Service, UX, security, and support boundaries state which downstream initiatives consume the
  record without taking their implementation scope.
- Dependencies link marketplace publisher trust, SBOM/vulnerability evidence, ADR-0062, ADR-0074,
  ADR-0075, curated catalog policy, and trust-tier policy.
- The follow-up gate blocks M1-M4 work until M0 acceptance is recorded.

## Negative Coverage

- Validation rejects marketplace review UI, publisher portal UI, storefront, and install-flow UX
  scope creep.
- Validation rejects monetization, paid publisher tier, payout, revenue, and live Registry storage
  scope creep.
- Validation rejects scanner integration, policy-engine enforcement, and approval-service
  implementation scope creep.
- Validation rejects customer-visible installability claims without a proof source and owner route.
- Rating signals are recorded as advisory and cannot substitute for security, provenance,
  conformance, or curation evidence.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\capability-review-approval-scope test
```
