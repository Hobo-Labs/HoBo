---
type: Reference
title: "Billing & Credits Scope And Acceptance"
description: "Source issue: HOBO-418."
tags: [hobo, design]
---

# Billing & Credits Scope And Acceptance

Source issue: HOBO-418.

Executable proof lives in
[`src/draft/exp-proofs/cx/billing-credits-scope-contract`](../../src/draft/exp-proofs/cx/billing-credits-scope-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-418-billing-credits`](./proofs/hobo-418-billing-credits/README.md).

## M0 Acceptance Record

Billing & Credits exists to define accepted commercial launch boundaries before downstream billing,
credit, payment-provider, metering, entitlement, tax, support, legal, and release work fans out. It
does not build a payment provider, invoice renderer, tax engine, usage metering pipeline, quota
enforcer, pricing page, or customer contract system.

M1/M2/M3/M4 follow-up issues must wait until this M0 scope record is accepted.

## User And Business Goal

HoBo needs accepted M0 scope for Billing & Credits before paid-launch work can claim that plans,
credits, invoices, payment states, customer-visible limits, or commercial readiness are safe. The
business goal is to prevent launch overclaims: workspace owners should know what billing state can
affect them, platform engineers should know which services own adjacent behavior, support should
have customer-safe routing, and legal/security reviewers should see which evidence blocks paid
launch.

## Primary Personas

| Persona | Need |
|---|---|
| Workspace owner | Understand which billing modes, credits, invoices, payment states, and visible limitations can affect a workspace before paid launch. |
| Platform engineer | Know which commercial boundaries are platform-owned and which usage, entitlement, tax, support, or legal surfaces remain outside this M0 record. |
| Billing operator | Trace billing lifecycle states, credit corrections, invoice evidence, and support-safe audit records without relying on provider dashboards. |
| Support engineer | Route payment, invoice, credit, tax, and entitlement questions to the owning initiative with customer-safe messages and evidence references. |
| Security and compliance reviewer | Verify payment credentials, tax posture, legal approvals, audit evidence, and customer-visible limitations are not hidden behind implementation claims. |

## Commercial Scope Map

| Commercial area | Billing & Credits owns | Owner outside this M0 record |
|---|---|---|
| Trial and beta plan posture | Accepted no-charge scope and visible limits | V1 Release Program & Cutline owns beta/GA go/no-go. |
| Paid plans and manual invoices | Launch policy boundary and handoff evidence | Legal/Privacy owns terms; provider integration waits for later accepted work. |
| Prepaid credits and corrections | Credit-state boundary and audit handoff | Entitlements owns runtime limit enforcement; Usage Metering owns source usage facts. |
| Invoices and disputes | Evidence input requirements and support route | HOBO-490 owns usage-to-invoice reconciliation. |
| Tax, currency, and receipts | Customer-visible blocker handoff | HOBO-513 owns tax, currency, receipt, and unsupported-jurisdiction obligations. |

## Scope In

- Accepted commercial scope map for trial, paid plan, manual invoice, prepaid credit, correction,
  and suspension states.
- Boundary record for where Billing & Credits owns launch policy versus Usage Metering,
  Entitlements, Tax/Currency/Receipts, Support, Legal/Privacy, and Release Cutline ownership.
- M1 evidence checklist for billing lifecycle state model, customer-visible limitations,
  credit/entitlement handoff, invoice reconciliation inputs, and audit/support handoff.
- Customer-visible limitation table for no-charge beta, paid GA prerequisites, manual invoicing,
  prepaid credits, and unsupported commercial states.
- Follow-up gate that blocks M1-M4 billing, credit, provider, tax, metering, or entitlement
  implementation until M0 scope and acceptance are recorded.

## Scope Out And Non-Goals

- Do not implement live payment provider, checkout, webhook, invoice rendering, payout, refund,
  charge, or settlement behavior.
- Do not implement usage metering, invoice line-item computation, provider billing sync, entitlement
  enforcement, quota enforcement, tax calculation, VAT/sales-tax collection, or currency expansion.
- Do not create final pricing pages, public price lists, sales packaging, launch marketing copy, or
  customer contract terms.
- Do not store payment credentials, tax identifiers, provider secrets, or live customer billing data.
- Do not create downstream M1-M4 execution issues before M0 scope is accepted.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Billing & Credits M0 defines accepted commercial lifecycle scope, handoff records, and evidence requirements; it does not build payment, invoice, tax, metering, entitlement, or provider services. |
| UX | UX scope is customer-visible billing state, limitation, and support message shape, not final pricing pages, checkout screens, invoice rendering, or marketing copy. |
| Security | Security scope records credential, tax identifier, audit, and provider assumptions; no payment credentials, tax identifiers, live provider secrets, or customer billing data are stored here. |
| Support | Support receives owner routes, customer-safe messages, audit evidence pointers, and limitation categories; support queues, SLAs, refunds, and escalation execution remain separate. |

## Owning Initiative Dependencies

| Owner | Consumes | Scope boundary |
|---|---|---|
| Billing & Credits | Accepted commercial scope map, lifecycle state families, credit boundary, customer-visible limitations, and follow-up gate. | This issue defines M0 scope and acceptance; live billing implementation waits for later accepted issues. |
| Usage Metering | Source usage facts and metering evidence for later invoices and credits. | Meter collection, aggregation, dedupe, and invoiceable quantity computation remain outside Billing & Credits M0. |
| Entitlements & Plan Limits | Billing and credit state as inputs to future runtime gates. | Quota, plan-limit, and deployment-time enforcement behavior stays outside this M0 record. |
| Tax, Currency & Receipt Obligations | Customer-visible tax, receipt, currency, and jurisdiction blockers for paid launch. | Tax calculation, receipt delivery, currency expansion, and legal review remain outside this M0 record. |
| Support Workflow | Customer-safe billing state, owner route, audit pointer, and safe next action. | Support queues, refund execution, SLA policy, and escalation process stay in Support Workflow. |
| V1 Legal, Privacy & Terms Readiness | Terms, refund, privacy, and billing-data obligations required before paid launch claims. | Legal approvals, contract terms, privacy notices, and tax/legal decisions are not authored here. |
| V1 Release Program & Cutline | Accepted scope, blockers, limitations, and evidence gaps for beta and GA readiness. | Release go/no-go, customer launch claims, and risk acceptance remain release-program scope. |

## M1 Evidence Required

| Evidence | Owner | Proof mode | Source |
|---|---|---|---|
| Commercial scope map | Billing & Credits | Design record | This document |
| Billing lifecycle state model | Billing & Credits | Contract test | [`billing-launch-policy-contract`](../../src/draft/exp-proofs/cx/billing-launch-policy-contract/README.md) |
| Credit ledger and entitlement boundary | Entitlements & Plan Limits | Contract test | [`credit-ledger-view-contract`](../../src/draft/technical-proofs/credit-ledger-view-contract/README.md) |
| Usage-to-invoice reconciliation inputs | Usage Metering | Reference fixture | HOBO-490 |
| Customer-visible billing limitations | Billing & Credits | Legal review | HOBO-513 |
| Support and audit handoff | Support Workflow | Support handoff | [governance planes](./governance-planes.md#plan-46) |

## Follow-Up Gate

Follow-up implementation issues are allowed only after M0 acceptance. Before that, billing, credit,
payment-provider, usage-metering, entitlement, tax, support, and release work must remain blocked or
explicitly routed to their owning initiative.
