---
type: Reference
title: "Billing Launch Policy"
description: "Source issue: HOBO-489."
tags: [hobo, design]
---

# Billing Launch Policy

Source issue: HOBO-489.

Executable proof lives in
[`src/draft/exp-proofs/cx/billing-launch-policy-contract`](../../src/draft/exp-proofs/cx/billing-launch-policy-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-489-billing-launch-policy`](./proofs/hobo-489-billing-launch-policy/index.md).

## M0 Acceptance Record

Billing launch policy exists to make commercial v1 behavior explicit without turning HoBo into a
payments, tax, or billing-provider implementation in this issue. The policy records supported plan
posture, prepaid credits, invoice timing, failed payment states, refund and credit-correction flow,
provider integration boundaries, and legal/privacy blockers.

## Supported Plans

| Plan | Billing mode | Entitlement impact |
|---|---|---|
| Private beta free plan | No charge | Beta workspace limits only; no invoice generated. |
| Team paid plan | Subscription | Paid workspace quota after checkout approval. |
| Enterprise manual plan | Manual invoice | Contract-defined quota and support terms. |

## Prepaid Credits And Invoice Timing

- Launch grants and prepaid credits apply before overage invoice line items.
- Monthly arrears is the default invoice cadence once a usage period closes.
- Usage evidence must remain traceable to the metering/showback source; billing policy does not
  replace [Plan 05](./reliability-observability-cost.md#plan-05) or
  [ADR-0039](./adr/02-identity-security.md#adr-0039).
- Corrections are account credits or reviewed refunds, not hidden plan mutations.

## Billing Lifecycle States

| State | Customer-visible message | Support action | Audit evidence | Entitlement impact |
|---|---|---|---|---|
| Trial active | Trial workspace is active; paid features remain unavailable until upgrade. | Route usage-limit questions to onboarding support. | `billing-trial-activated` | Trial quota only. |
| Subscription active | Paid subscription is active and recurring invoices are enabled. | Explain plan limits without granting hidden quota. | `billing-subscription-activated` | Paid plan quota applies. |
| Credits depleted | Prepaid credits are depleted; later usage follows invoice policy. | Explain usage evidence and route disputes to correction review. | `credit.Exhausted` | Overage or hard-cap policy decides. |
| Invoice open | Invoice is available for review before payment due date. | Surface line-item evidence and mark disputes. | `invoice-opened` | No restriction while open. |
| Payment past due | Payment is past due; existing workloads stay available during grace. | Route to billing owner and explain grace limits. | `payment-past-due` | Block quota increases and new paid upgrades. |
| Payment suspended | Paid deploy changes are suspended until payment is restored. | Escalate account recovery and preserve export access. | `payment-suspended` | Block new paid deploys; keep export and support access. |
| Refund pending | Refund request is under review. | Attach reason, line items, and reviewer. | `refund-requested` | No entitlement change until approved. |
| Credit corrected | Usage correction was applied as account credit. | Link correction to disputed usage evidence and invoice adjustment. | `credit-corrected` | Credit offsets later invoice; no hidden plan mutation. |

## Provider Integration Boundary

| Boundary | V1 assumption | Mocked-provider behavior | Scope boundary |
|---|---|---|---|
| Checkout session | Deterministic fixtures stand in until provider selection is approved. | Success, decline, and abandoned checkout outcomes. | No checkout API or stored payment credentials in HOBO-489. |
| Webhook events | Provider events are signed fixture events for proof. | Invoice paid, payment failed, refund approved, duplicate delivery. | No live webhook endpoint, signature secret, or replay worker. |
| Invoice sync | Line items derive from usage evidence and fixture ids. | Deterministic invoice status for support/audit assertions. | No provider data sync or invoice rendering. |
| Money movement | External provider responsibility behind a future approved integration. | Requested, approved, denied, and corrected states only. | No charge, refund, payout, tax, or settlement action. |

## Legal And Privacy Inputs

| Input | Owner | Launch disposition | Evidence |
|---|---|---|---|
| Terms of service | V1 Legal, Privacy & Terms Readiness | Blocker | HOBO-405 |
| Refund policy | V1 Legal, Privacy & Terms Readiness | Blocker | HOBO-405 |
| Billing-data retention | V1 Legal, Privacy & Terms Readiness | Limitation | [Plan 46](./governance-planes.md#plan-46) |
| Tax, currency, and receipts | Billing & Credits | Blocker | [HOBO-513 tax/currency/receipt obligations](./tax-currency-receipt-obligations.md) |

## Scope Out And Non-Goals

- Do not implement a tax engine or jurisdiction decisioning here.
- Do not integrate a live payment provider, webhook endpoint, checkout session, or settlement flow.
- Do not draft final legal terms, refund-policy text, privacy text, or compliance claims.
- Do not replace FinOps metering, showback, quota, or cost-safety design.
- Do not create M1-M4 implementation tasks before M0 acceptance is reviewed.

## Authoritative Dependencies

- [ADR-0064](./adr/07-portability-extensibility.md#adr-0064) keeps business/monetization mechanics
  outside the meta-cloud core; [ADR-0107](./adr/07-portability-extensibility.md#adr-0107) records
  that this launch-readiness policy is design-scope hosted-business productization, not core billing
  machinery.
- [Plan 05](./reliability-observability-cost.md#plan-05) and
  [ADR-0039](./adr/02-identity-security.md#adr-0039) own metering, showback, quotas, and cost
  safety.
- [Plan 46](./governance-planes.md#plan-46) owns legal/privacy evidence posture.
- [HOBO-513](./tax-currency-receipt-obligations.md) owns tax, currency, receipt, invoice metadata,
  and unsupported-jurisdiction posture.

## Evidence Required For M1

| Evidence | Owner | Proof mode | Proves |
|---|---|---|---|
| Policy fixture | Billing & Credits | Contract test | Supported plans, credits, invoices, payment failures, refunds, and scope-out are defined. |
| Lifecycle state table | Billing & Credits | Design record | Every customer-visible state has support, audit, and entitlement impact. |
| Mock provider fixture | Billing & Credits | Contract test | Provider assumptions can be tested without live money movement. |
| Legal blocker register | V1 Legal, Privacy & Terms Readiness | Design record | Legal/privacy inputs are blockers or limitations, not silent launch assumptions. |
| Scope guard | Release cutline | Contract test | Tax engines, live payment integrations, and final legal text stay out of HOBO-489. |

## Follow-Up Gate

M1/M2/M3/M4 design or implementation issues must wait until this M0 policy is accepted. This branch
records the policy and executable guard; it does not create provider, tax, checkout, invoice, or
money-movement implementation work.
