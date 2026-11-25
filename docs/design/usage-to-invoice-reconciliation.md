---
type: Reference
title: "Usage-To-Invoice Reconciliation Contract"
description: "Source issue: HOBO-490."
tags: [hobo, design]
---

# Usage-To-Invoice Reconciliation Contract

Source issue: HOBO-490.

Executable proof lives in
[`src/draft/technical-proofs/usage-to-invoice-reconciliation-contract`](../../src/draft/technical-proofs/usage-to-invoice-reconciliation-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-490-usage-to-invoice-reconciliation`](./proofs/hobo-490-usage-to-invoice-reconciliation/README.md).

## M1 Contract Record

Usage-to-invoice reconciliation exists to prove invoice-adjacent evidence before
paid launch claims depend on it. It consumes Usage Metering facts, Billing
Launch Policy lifecycle states, and Tax/Currency/Receipt obligations, then emits
deterministic line-item, correction, late-event, replay, dispute, and support
audit evidence without implementing billing-provider or production finance
systems.

## Scope In

- Mapping usage events to invoice line items with source event references,
  quantities, units, amounts, reporting period, and customer-safe summaries.
- Mapping support-approved corrections to explicit refund or credit adjustment
  lines.
- Mapping late usage into next-period adjustments while retaining original
  occurrence period.
- Replay and idempotency evidence for duplicate suppression and deterministic
  invoice-adjacent output.
- Support-visible audit records for disputes and corrections.
- Privacy constraints for customer-visible usage details.

## Scope Out And Non-Goals

- Do not implement a live payment provider, checkout, invoice renderer, tax
  engine, refund processor, or production finance integration.
- Do not build a production metering ingestion service, provider billing sync,
  settlement flow, or customer payment credential handling.
- Do not calculate legal tax, file returns, or issue customer invoices.
- Do not mutate entitlements or plan limits.

## Reconciliation Mapping

| Mapping | Source | Output | Proof |
|---|---|---|---|
| Usage event to line item | `meter.UsageRecorded` | `invoice.LineItem` | Line item keeps source usage refs, quantity, unit, amount, period, and redacted customer summary. |
| Correction to adjustment line | `support.UsageCorrectionApproved` | `invoice.AdjustmentLine` | Refund or credit correction becomes an explicit negative line with support audit refs. |
| Late event to next-period adjustment | Usage received after period close | `invoice.LateUsageAdjustment` | Adjustment keeps original occurrence period and marks late-event status. |
| Replay to idempotent ledger | `meter.Replay` | Idempotency ledger | Replay keeps idempotency and duplicate-suppression keys deterministic. |
| Support audit record | `support.DisputeOpened` | Support audit record | Audit records retain lineage while customer-visible line items stay redacted. |

## Deterministic Fixtures

| Fixture | Proves |
|---|---|
| Normal usage | Current-period compute usage becomes a normal invoice line item. |
| Late usage | Prior-period usage received after close becomes a late-usage adjustment. |
| Duplicate usage | Duplicate storage usage contributes one line item and replayable duplicate audit evidence. |
| Refund or credit correction | A support-approved correction becomes an explicit negative adjustment. |
| Disputed usage | Disputed usage is held from invoice amount while support lineage remains visible. |

## Privacy Constraints

Customer-visible usage details expose category, quantity, unit, and period only.
They must not include raw user identifiers, email addresses, internal resource
ids, support notes, payload excerpts, or provider internals. Support audit
records keep source event refs, reason, redacted-field list, retention class,
and dispute/correction lineage for replay.

## Authoritative Dependencies

- [usage-metering.md](./usage-metering.md) owns source usage facts and metering
  boundaries.
- [billing-launch-policy.md](./billing-launch-policy.md) owns billing lifecycle
  states, refund/credit correction policy, and mocked-provider assumptions.
- [tax-currency-receipt-obligations.md](./tax-currency-receipt-obligations.md)
  owns tax, currency, receipt, invoice metadata, and unsupported-jurisdiction
  posture.
- [ADR-0039](./adr/02-identity-security.md#adr-0039) separates metering,
  showback, quota, and cost attribution from chargeback/invoicing machinery.
- [ADR-0107](./adr/07-portability-extensibility.md#adr-0107) records that this reconciliation
  contract is a hosted-business productization record while the product billing surface stays
  removed per [ADR-0064](./adr/07-portability-extensibility.md#adr-0064).

## Acceptance Evidence

The executable proof covers the HOBO-490 acceptance bullets:

- usage event to invoice line item mapping;
- corrections, late events, replay, disputes, and support audit records;
- deterministic normal/late/duplicate/correction/dispute fixtures;
- customer-visible privacy constraints; and
- scope guards against live payment-provider and production finance integration
  creep.
