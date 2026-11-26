---
type: Reference
title: "HOBO-420 Marketplace Payout Hooks Proof"
description: "Source issue: HOBO-420."
tags: [hobo, design]
---

# HOBO-420 Marketplace Payout Hooks Proof

HOBO-420 is proven by the focused M0 contract at
[`src/draft/exp-proofs/cx/marketplace-payout-hooks-scope-contract`](../../../../src/draft/exp-proofs/cx/marketplace-payout-hooks-scope-contract/README.md)
and the durable scope record at
[marketplace-payout-hooks.md](../../marketplace-payout-hooks.md).

## Acceptance Evidence

- User/business goal and primary personas are explicit.
- Scope in/out and non-goals are recorded.
- Service, UX, security, and support boundaries are mapped.
- Dependencies link marketplace trust, capability review, org catalogs, billing,
  tax/currency/receipt obligations, support escalation, and ADR-0064.
- Payout-readiness states define eligibility, required handoffs, approval, hold,
  and disabled outcomes without executing settlement.
- M1 proof requirements name owner, source, proof mode, and claim.
- Follow-up M1-M4 work is blocked until M0 acceptance.

## Negative Coverage

- Validation rejects live payout provider integration.
- Validation rejects settlement or money movement.
- Validation rejects tax form/document scope.
- Validation rejects payout UI, publisher portal, or marketplace storefront scope.
- Validation rejects KYC/KYB, bank account, payment-provider, and revenue-share creep.
- Validation rejects payout claims without proof source or missing payout states.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\marketplace-payout-hooks-scope-contract test
```
