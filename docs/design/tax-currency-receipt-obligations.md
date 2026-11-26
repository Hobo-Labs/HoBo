---
type: Reference
title: "Tax, Currency, Receipt, And Invoice Compliance Obligations"
description: "Source issue: HOBO-513."
tags: [hobo, design]
---

# Tax, Currency, Receipt, And Invoice Compliance Obligations

Source issue: HOBO-513.

Executable proof lives in
[`src/draft/technical-proofs/tax-currency-receipt-obligations-contract`](../../src/draft/technical-proofs/tax-currency-receipt-obligations-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-513-tax-currency-receipt-obligations`](./proofs/hobo-513-tax-currency-receipt-obligations/README.md).

## M0 Acceptance Record

HoBo v1 commercial readiness needs an explicit answer for tax, currency, receipt, invoice metadata,
customer billing identity, and unsupported jurisdictions. This record defines the launch posture and
blocking unknowns without implementing a tax engine, invoice renderer, payment provider, payout
provider, settlement flow, or final legal terms.

## Scope In

- Supported currency posture, including USD-first self-serve launch and zero-decimal handling
  before additional currencies are accepted.
- Tax/VAT/sales-tax posture for beta, paid GA, manual invoicing, prepaid credits, subscriptions, and
  marketplace payout hooks.
- Invoice and receipt metadata requirements that remain required even when an external provider
  renders the customer artifact.
- Customer billing identity fields required before paid, manual invoice, or payout commitments.
- Unsupported-jurisdiction blockers and customer-visible limitations.
- Handoffs to billing launch policy, usage-to-invoice reconciliation, usage metering, and billing
  scope records.

## Scope Out And Non-Goals

- Do not implement a tax engine, tax filing, jurisdiction decisioning, live tax calculation, or
  automated tax collection.
- Do not integrate a live payment, invoice, receipt, payout, settlement, or marketplace provider.
- Do not draft final tax advice, customer terms, DPA language, privacy text, or legal policy.
- Do not create downstream M1-M4 tax/provider implementation issues before M0 acceptance and v1
  cutline review.

## Obligation Domains

| Domain | Owner | Launch posture | Customer-visible limit |
|---|---|---|---|
| Supported currencies | Billing owner | USD-first self-serve launch; additional currencies require review. | Non-USD paid launch is unsupported until currency evidence exists. |
| Tax/VAT/sales-tax | Billing owner plus legal/privacy owner | Tax collection is blocker unless provider or manual-review evidence exists. | HoBo does not claim automated tax calculation in v1. |
| Invoice/receipt requirements | Billing owner | Metadata is required even when rendered externally. | Artifact format may vary by launch mode/provider. |
| Customer billing identity | Workspace admin and billing owner | Paid flows require legal name, billing email, address, region, and optional tax id capture posture. | Missing identity fields can block paid, manual invoice, or payout commitments. |
| Zero-decimal currencies | Billing owner | Minor-unit math must be fixture-proven before non-USD support. | Zero-decimal self-serve charges are unsupported until fixture evidence exists. |
| Unsupported jurisdictions | Billing owner plus legal/privacy owner | Unsupported regions are blockers or limitations, never silent acceptance. | Unsupported regions must be visible before checkout, invoice, or payout commitment. |

## Launch Mode Mapping

| Mode | Required before | Evidence owner | Blocking unknowns |
|---|---|---|---|
| Private beta | Invite | Billing & Credits | Billing identity minimum, no-charge customer copy |
| Paid GA | Checkout | Billing & Credits; V1 Legal, Privacy & Terms Readiness | Paid-GA tax collection, final legal review |
| Manual invoicing | Enterprise invoice | Billing & Credits | Manual-invoice tax review, invoice metadata owner |
| Prepaid credits | Credit purchase or launch grant | Billing & Credits | Credit receipt treatment, credit expiry copy |
| Subscriptions | Recurring paid plan | Billing & Credits | Renewal receipt evidence, subscription tax posture |
| Marketplace payout hooks | Publisher payout commitment | Capability Review & Approval | Marketplace payout tax documents, publisher tax identity |

## Provider Assumptions

| Boundary | Assumption | Customer impact | Non-goal |
|---|---|---|---|
| Tax determination | Future external provider or manual legal/billing review supplies determination. | Unsupported regions are blocked or disclosed before checkout. | No internal tax decisioning engine. |
| Invoice rendering | External provider or manual enterprise process renders invoices. | Metadata remains auditable and linked to usage evidence. | No invoice rendering service. |
| Receipt delivery | Provider-backed or manual until launch provider is accepted. | Receipt availability and channel are visible by launch mode. | No receipt email, inbox, or provider integration. |
| Marketplace payout documents | Depends on future payout scope. | Publisher payouts cannot be promised without tax-document and identity posture. | No payout settlement, 1099/VAT document, or revenue-share work. |

## Customer-Visible Limitations

- HoBo v1 does not provide automated tax/VAT/sales-tax calculation unless the v1 cutline changes.
- Self-serve paid launch starts USD-first; more currencies require evidence and review.
- Unsupported jurisdictions must be visible before checkout, invoice, or payout commitment.
- Marketplace payout tax documents are deferred until payout hooks are in accepted scope.

## Unsupported Jurisdictions

| Unknown | Disposition | Customer message | Support route |
|---|---|---|---|
| Paid-GA tax collection | Blocker | Paid GA checkout is blocked until tax collection evidence exists. | Billing owner plus legal owner |
| Manual-invoice tax review | Blocker | Manual invoice requires billing/legal tax review before commitment. | Billing owner plus legal owner |
| Non-US self-serve signup | Limitation | Non-US self-serve paid signup may be unavailable during v1 launch. | Support owner routes to billing owner |
| Marketplace payout tax documents | Limitation | Marketplace payouts and related tax documents are not promised in v1. | Capability Review & Approval owner |

## Reconciliation Handoffs

| Issue | Workflow | Handoff evidence |
|---|---|---|
| HOBO-489 | Billing lifecycle states and refund/credit correction policy. | Billing launch policy record and legal/privacy input table. |
| HOBO-490 | Usage events reconcile to invoice line items, corrections, disputes, and audit records. | Usage-to-invoice reconciliation contract. |
| HOBO-417 | Usage Metering M0 scope owns source usage facts and metering boundaries. | Usage metering scope acceptance record. |
| HOBO-418 | Billing & Credits M0 scope owns commercial launch boundaries and follow-up gate. | Billing and credits scope acceptance record. |

Commercial readiness cannot be claimed from plan/pricing tickets alone. A launch-ready claim must
cite tax/currency/receipt obligations, invoice reconciliation, and customer-visible limitations.

## Authoritative Dependencies

- [billing-launch-policy.md](./billing-launch-policy.md) owns plans, credits, invoices, payment
  failures, refunds, and provider/legal boundaries.
- [ADR-0064](./adr/07-portability-extensibility.md#adr-0064) keeps business/monetization mechanics
  outside HoBo's meta-cloud core; [ADR-0107](./adr/07-portability-extensibility.md#adr-0107)
  records tax/currency/receipt posture as hosted-business productization records.
- [ADR-0110](./adr/07-portability-extensibility.md#adr-0110) governs the marketplace payout
  tax-document posture as a deferred commercial-operations limitation, not product billing scope.
- [ADR-0039](./adr/02-identity-security.md#adr-0039) owns metering, quota, cost attribution, and
  showback without chargeback/invoicing machinery.
- [Plan 46](./governance-planes.md#plan-46) owns compliance/data-governance evidence posture.

## Follow-Up Gate

M1-M4 tax, provider, invoice, receipt, or payout implementation work remains blocked until this M0
record is accepted and the v1 cutline explicitly requires it. This branch records the posture and
executable guard; it does not create downstream implementation work.
