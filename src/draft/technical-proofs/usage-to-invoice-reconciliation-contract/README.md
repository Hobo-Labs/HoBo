# Usage-To-Invoice Reconciliation Contract

Independent POC for HOBO-490. It proves that usage facts can be transformed into
invoice-adjacent evidence without implementing billing-provider, payment, tax,
invoice-rendering, or production finance integrations.

## Contract Surface

- `USAGE_TO_INVOICE_RECONCILIATION_CONTRACT` is versioned as
  `hobo.usage-to-invoice-reconciliation/v1`.
- Required mappings cover usage events to invoice line items, corrections,
  late events, replay/idempotency, and support-visible audit records.
- Deterministic fixtures cover normal usage, late usage, duplicate usage,
  refund or credit correction, and disputed usage.
- Customer-visible line items are redacted summaries; support audit records
  retain replayable lineage and redacted-field evidence.
- Scope guards reject live payment provider work and production finance
  integration claims.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\usage-to-invoice-reconciliation-contract test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for the contract.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
