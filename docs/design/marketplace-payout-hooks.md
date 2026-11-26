---
type: Reference
title: "Marketplace Payout Hooks Scope And Acceptance"
description: "Source issue: HOBO-420."
tags: [hobo, design]
---

# Marketplace Payout Hooks Scope And Acceptance

Source issue: HOBO-420.

Executable proof lives in
[`src/draft/exp-proofs/cx/marketplace-payout-hooks-scope-contract`](../../src/draft/exp-proofs/cx/marketplace-payout-hooks-scope-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-420-marketplace-payout-hooks`](./proofs/hobo-420-marketplace-payout-hooks/README.md).

## M0 Acceptance Record

Marketplace Payout Hooks exists to define the accepted productization boundary
for publisher payout readiness, eligibility states, tax/identity handoffs,
billing reconciliation, payout hold reasons, and support-safe limitations. It
does not build payout execution, settlement, provider integration, tax document
flows, revenue sharing, marketplace UI, or money movement. The governing
boundary decision is [ADR-0110](./adr/07-portability-extensibility.md#adr-0110):
payout readiness is a launch-gated commercial-operations posture, not reinstated
marketplace monetization.

## User And Business Goal

HoBo needs accepted M0 scope for Marketplace Payout Hooks before marketplace,
publisher, billing, tax, support, and release work can make payout-adjacent
claims. The accepted record must tell operators which evidence is required,
which states are visible, who owns adjacent commercial compliance decisions, and
which claims remain launch limitations.

## Primary Personas

| Persona | Need |
|---|---|
| Marketplace operator | Know when a listing can expose payout-readiness status without promising settlement or live money movement. |
| Publisher owner | Understand which identity, tax, support, and catalog evidence is needed before payout commitments can be discussed. |
| Billing/compliance owner | Receive payout-adjacent evidence while tax, receipt, provider, and settlement decisions stay in the commercial compliance lane. |
| Support operator | Explain payout eligibility, holds, disabled states, and unsupported states from customer-safe evidence. |
| Release owner | Block paid marketplace or payout launch claims until accepted M0 scope and follow-up evidence exist. |

## Scope In

- Publisher payout-readiness vocabulary for eligibility review, required tax/identity handoff,
  payout method handoff, approval, hold, disabled, and unsupported states.
- Evidence fields for publisher identity, listing trust tier, org catalog approval, payout owner
  route, hold reason, support wording, and billing reconciliation handoff.
- State model for payout-adjacent launch readiness that can be consumed by marketplace, publisher,
  billing, tax, org catalog, and support follow-up work.
- Customer-visible limitation wording for paid marketplace and payout claims until commercial
  provider, legal, tax, and support evidence are accepted.
- M1-ready evidence checklist for publisher eligibility fixtures, state model, tax identity
  handoff, billing reconciliation, support export, and scope boundary register.

## Scope Out And Non-Goals

- Do not integrate a live payout provider, execute payouts, settle funds, handle bank accounts, or
  move money.
- Do not generate tax forms, collect tax documents, automate tax decisioning, run 1099/VAT
  workflows, or provide legal advice.
- Do not define final revenue-share policy, paid publisher tiers, marketplace monetization, or
  commercial pricing.
- Do not build marketplace storefront, publisher portal UI, payout UI, support console, or customer
  billing dashboard surfaces.
- Do not integrate payment providers, billing providers, KYC/KYB providers, fraud systems, or
  compliance vendors.
- Do not create downstream M1-M4 execution issues before M0 scope is accepted.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Marketplace Payout Hooks M0 defines payout-readiness states, evidence fields, and owner handoffs; it does not build a payout service, ledger, provider integration, or settlement runtime. |
| UX | UX scope is information architecture for future payout-readiness and limitation wording, not marketplace storefront, publisher portal, payout setup, or support-console screens. |
| Security | Security scope records identity, trust-tier, org-catalog, tax, and compliance evidence requirements without storing payment credentials, tax documents, or bank details. |
| Support | Support receives customer-safe payout status, hold reason, disabled reason, unsupported-state wording, and escalation owner; support tooling and SLAs remain separate. |

## Publisher Payout Readiness States

| State | Meaning |
|---|---|
| `not-eligible` | Listing, publisher, catalog, or review prerequisites are missing; no payout claim is visible. |
| `eligible-for-review` | Required marketplace and trust evidence exists, but payout handoffs still need review. |
| `tax-documents-required` | Commercial compliance needs tax identity or document posture before payout commitments. |
| `payout-method-required` | Future provider or manual process needs a payout method handoff; no provider is integrated here. |
| `approved-for-payout` | Required evidence exists for a later payout workflow to proceed, without executing settlement. |
| `payout-held` | Payout readiness is paused with a customer-safe hold reason and owner route. |
| `payout-disabled` | Payout claims are disabled for the listing, publisher, jurisdiction, catalog, or release cutline. |

## Authoritative Dependencies

- [Marketplace publisher trust evidence](./marketplace-publisher-trust-evidence.md) defines
  publisher trust tiers and keeps paid marketplace/payout claims as launch limitations until
  evidence exists.
- [Capability Review & Approval](./capability-review-approval.md) defines review states, approval
  outcomes, trust-tier evidence, and security/conformance handoffs.
- [Org Catalogs](./org-catalogs.md) defines private listing, catalog approval, policy, and support
  evidence that payout readiness consumes without taking catalog scope.
- [Billing Launch Policy](./billing-launch-policy.md) defines commercial billing lifecycle and
  provider boundaries while keeping money movement and payment providers out of this issue.
- [Tax, Currency, Receipt Obligations](./tax-currency-receipt-obligations.md) defines tax, currency,
  receipt, invoice metadata, and marketplace payout tax-document limitations.
- [Launch Support Escalation](./launch-support-escalation.md) defines customer-safe support
  escalation and gap-routing posture for payout holds, unsupported states, and release blockers.
- [ADR-0064](./adr/07-portability-extensibility.md#adr-0064) keeps monetization mechanics outside
  HoBo's meta-cloud core.
- [ADR-0110](./adr/07-portability-extensibility.md#adr-0110) records that payout readiness is a
  launch-gated commercial-operations posture and does not reinstate the marketplace monetize/rev-share
  scope removed by ADR-0064.

## Owning Initiative Dependencies

| Owner | Consumes from Marketplace Payout Hooks | Boundary |
|---|---|---|
| Marketplace Payout Hooks | Accepted payout-readiness states, evidence checklist, and follow-up gate. | This issue defines M0 scope and acceptance; it does not build payout execution. |
| Capability Review & Approval | Review outcome, trust-tier, security, conformance, and yank/escalation evidence before payout readiness is visible. | Review queues and approval service behavior remain in Capability Review & Approval. |
| Publisher Portal | Required identity, tax, payout-method, and support wording in later publisher-facing flows. | Publisher onboarding, forms, UI, and maintainer administration stay in Publisher Portal. |
| Billing & Credits | Billing reconciliation, payment-provider, credit, refund, and invoice-adjacent handoff requirements. | Billing plans, invoices, payment providers, refunds, and credit application remain Billing & Credits. |
| Tax, Currency, Receipt Obligations | Tax identity, currency, receipt, unsupported jurisdiction, and payout-document posture. | Tax documents, legal review, provider tax flows, and compliance claims stay outside this scope record. |
| Org Catalogs | Catalog approval and private-listing state as prerequisites for publisher payout readiness. | Catalog storage, approval workflow, policy enforcement, and registry handoff remain Org Catalogs. |
| Support Workflow | Hold reason, disabled reason, unsupported-state wording, and escalation owner for customer-safe support. | Support queues, SLAs, ticket automation, and incident communications stay outside this issue. |
| V1 Release Program & Cutline | Accepted M0 scope for deciding when M1-M4 follow-up issues can be created. | Release go/no-go, cutline decisions, and downstream issue creation remain release-program scope. |

## Evidence Required For M1

| Evidence | Owner | Source | Proof mode | Proves |
|---|---|---|---|---|
| Publisher eligibility fixture | Marketplace operator | Publisher payout-readiness state table | Reference fixture | Publisher trust, catalog approval, and review state prerequisites are visible before payout readiness is claimed. |
| Payout state model | Marketplace operator | Publisher payout-readiness state table | Contract test | Not eligible, review, required handoff, approved, held, and disabled states are deterministic. |
| Tax identity handoff | Billing/compliance owner | Tax/currency launch-mode mapping | Compliance review | Tax identity and payout-document requirements are explicit handoffs, not implemented in payout scope. |
| Billing reconciliation handoff | Billing/compliance owner | Billing launch provider boundary | Design record | Billing and provider assumptions are named without payout execution or settlement machinery. |
| Support hold reason export | Support operator | Launch support gap routing | Support handoff | Support can route holds, disabled states, and unsupported claims to named owners with safe wording. |
| Scope boundary register | Release owner | Scope out and non-goals | Design record | Live payout provider, settlement, tax, UI, KYC/KYB, and revenue-share implementation work stays out. |

## Follow-Up Gate

M1/M2/M3/M4 design or implementation issues must wait until this M0 scope record is accepted. This
branch records the gate and its executable guard; it does not create follow-up implementation
issues.
