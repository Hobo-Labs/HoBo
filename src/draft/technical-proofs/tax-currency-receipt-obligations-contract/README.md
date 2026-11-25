# Tax Currency Receipt Obligations Contract POC

Independent POC for HOBO-513. It pins the v1 launch posture for tax, currency, invoice,
receipt, customer billing identity, zero-decimal handling, and unsupported jurisdictions without
implementing a tax engine, tax filing, live provider integration, payout settlement, or invoice
renderer.

## Contract Surface

- `TAX_CURRENCY_RECEIPT_OBLIGATIONS` is versioned as
  `hobo.tax-currency-receipt-obligations/v1`.
- Required obligation domains cover supported currencies, tax/VAT/sales-tax posture,
  invoice/receipt requirements, customer billing identity fields, zero-decimal currencies, and
  unsupported jurisdictions.
- Launch mode mappings cover private beta, paid GA, manual invoicing, prepaid credits,
  subscriptions, and marketplace payout hooks.
- Provider assumptions and customer-visible limitations must be explicit.
- Reconciliation links map disputes, corrections, refunds, and usage evidence to HOBO-489,
  HOBO-490, HOBO-417, and HOBO-418.

## Scope Boundaries

Included:

- Deterministic M0 obligation fixture and validator.
- Customer-visible limitation and unsupported-jurisdiction classification.
- Launch-mode readiness mapping.
- Tax-engine scope guard tied to v1 cutline review.

Excluded:

- Tax calculation, filing, jurisdiction decisioning, or automated tax collection.
- Live payment, invoice, receipt, payout, settlement, or marketplace provider integration.
- Final legal text, customer terms, DPA, or tax advice.
- Downstream M1-M4 tax/provider implementation fan-out before M0 acceptance.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\tax-currency-receipt-obligations-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Tax Currency Receipt Obligations Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
