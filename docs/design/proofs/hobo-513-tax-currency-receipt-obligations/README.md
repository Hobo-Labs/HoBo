---
type: Reference
title: "HOBO-513 Tax Currency Receipt Obligations Proof"
description: "Source issue: HOBO-513."
tags: [hobo, design]
---

# HOBO-513 Tax Currency Receipt Obligations Proof

HOBO-513 is proven by the focused M0 contract at
[`src/draft/technical-proofs/tax-currency-receipt-obligations-contract`](../../../../src/draft/technical-proofs/tax-currency-receipt-obligations-contract/README.md)
and the durable scope record at
[tax-currency-receipt-obligations.md](../../tax-currency-receipt-obligations.md).

## Acceptance Evidence

- Supported currencies, tax/VAT/sales-tax posture, invoice/receipt requirements, customer billing
  identity, zero-decimal handling, and unsupported jurisdictions are defined.
- Private beta, paid GA, manual invoicing, prepaid credits, subscriptions, and marketplace payout
  hooks each map to required evidence, owners, visible limits, and blocking unknowns.
- Provider assumptions and customer-visible limitations are explicit.
- Disputes, corrections, refunds, and usage reconciliation are linked to HOBO-489, HOBO-490,
  HOBO-417, and HOBO-418.
- Tax engine work is blocked unless the v1 cutline explicitly requires it after M0 acceptance.

## Negative Coverage

- Plan/pricing-only commercial readiness claims are rejected.
- Tax-engine or jurisdiction-decisioning scope creep is rejected.
- Missing tax/currency/receipt obligation domains are rejected.
- Missing launch modes, including marketplace payout hooks, are rejected.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\tax-currency-receipt-obligations-contract test
```
