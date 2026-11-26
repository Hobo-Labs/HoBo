---
type: Reference
title: "HOBO-421 Marketplace UX Proof"
description: "Source issue: HOBO-421."
tags: [hobo, design]
---

# HOBO-421 Marketplace UX Proof

HOBO-421 is proven by the focused M0 contract at
[`src/draft/exp-proofs/ux/marketplace-ux-scope-contract`](../../../../src/draft/exp-proofs/ux/marketplace-ux-scope-contract/README.md)
and the durable scope record at
[marketplace-ux.md](../../marketplace-ux.md).

## Acceptance Evidence

- User/business goal and primary personas are explicit.
- Scope in/out and non-goals are recorded.
- Service, UX, security, and support boundaries are mapped.
- Dependencies link marketplace trust, capability review, org catalogs, accessibility, product
  notifications, launch claims, ADR-0062, and ADR-0074.
- Listing states define hidden, preview, limited-beta, installable, policy-blocked, deprecated, and
  yanked outcomes.
- Installability outcomes require owner route, evidence source, and customer-safe wording.
- M1 proof requirements name owner, source, proof mode, and claim.
- Follow-up M1-M4 work is blocked until M0 acceptance.

## Negative Coverage

- Validation rejects live storefront or browse/search implementation.
- Validation rejects install runtime or Registry storage.
- Validation rejects ratings ranking, recommendations, paid placement, monetization, payout, or
  revenue-share creep.
- Validation rejects publisher portal UI, publisher onboarding, scanner, policy, RBAC, support, or
  notification implementation scope.
- Validation rejects customer-visible installability claims without evidence source and owner route.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\marketplace-ux-scope-contract test
```
