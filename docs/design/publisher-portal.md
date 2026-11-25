---
type: Reference
title: "Publisher Portal Scope And Acceptance"
description: "Source issue: HOBO-422."
tags: [hobo, design]
---

# Publisher Portal Scope And Acceptance

Source issue: HOBO-422.

Executable proof lives in
[`src/draft/exp-proofs/ux/publisher-portal-scope-contract`](../../src/draft/exp-proofs/ux/publisher-portal-scope-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-422-publisher-portal`](./proofs/hobo-422-publisher-portal/README.md).

## M0 Acceptance Record

Publisher Portal exists to define accepted productization scope before downstream
M1-M4 publisher profile, maintainer administration, listing submission, review
status, payout-readiness, and support handoff work can depend on it. It is not
the portal UI, review decision engine, Registry storage, marketplace storefront,
payout system, billing dashboard, or support queue.

## User And Business Goal

HoBo needs accepted M0 scope for the Publisher Portal before it can claim
publishers can onboard, submit capabilities, see review status, understand payout
readiness, or receive customer-safe support outcomes. The accepted record must
tell publisher owners, maintainers, marketplace operators, security reviewers,
support operators, and release owners which records exist, which evidence is
required, which owners consume status changes, and which adjacent initiatives
remain out of scope.

## Primary Personas

| Persona | Need |
|---|---|
| Publisher owner | Know which publisher profile, organization identity, listing evidence, and maintainer responsibilities must exist before a portal workflow is designed. |
| Publisher maintainer | Understand which listing draft, evidence upload, review status, and yank/rejection messages are visible without gaining approval authority. |
| Marketplace operator | Route publisher submissions into review, catalog, payout-readiness, and support owners without the portal becoming the decision engine. |
| Security reviewer | Require provenance, conformance, SBOM, vulnerability, and security-review evidence before installability or trust claims are visible. |
| Support operator | Explain rejected, yanked, escalated, and payout-blocked states with customer-safe owner routes and limitation wording. |
| Release owner | Block publisher portal launch claims and follow-up issue fan-out until accepted M0 scope and proof requirements exist. |

## Scope In

- Publisher profile and organization identity fields needed for future publisher onboarding,
  verification, support routing, and review intake.
- Maintainer role vocabulary for owner, maintainer, reviewer-contact, billing-contact, and
  support-contact responsibilities.
- Listing submission evidence envelope for capability metadata, artifact provenance, capability
  spec, SBOM/vulnerability notice, conformance report, and customer-visible warning text.
- Review-status projection vocabulary for submitted, evidence-required, limited-beta, installable,
  rejected, yanked, and escalated states consumed from Capability Review & Approval.
- Payout-readiness handoff fields that show eligibility, blocked reason, tax/identity owner, and
  unsupported payout limitations without executing payouts.
- Support-safe status messages, owner routes, and limitation wording for publisher, marketplace,
  support, and release handoff surfaces.
- M1-ready evidence checklist for profile fixture, maintainer permission matrix, evidence envelope,
  review projection, payout handoff, support handoff, and scope boundary register.

## Scope Out And Non-Goals

- Do not build React implementation, publisher portal UI, portal screens, design system work, or
  frontend routing.
- Do not build review approval service, security scanner integration, conformance runner
  implementation, or approval policy enforcement.
- Do not build live Registry storage, package hosting, artifact publish/pull runtime, signing
  service, or Registry distribution implementation.
- Do not build marketplace storefront, install-flow UX, trust-badge renderer, search, browse, or
  customer purchase flow.
- Do not build payout provider integration, tax document collection, bank account handling,
  settlement, revenue-share, or money movement.
- Do not build billing dashboard, invoice flow, payment-provider integration, refund handling, or
  commercial pricing decisions.
- Do not build support ticket queue, SLA automation, incident communication, or customer support
  console implementation.
- Do not create downstream M1-M4 execution issues before M0 scope is accepted.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Publisher Portal M0 defines accepted publisher profile, maintainer role, listing evidence, review-status, payout-readiness, and support handoff records; it does not build portal services, approval services, Registry storage, payout execution, billing, or support tooling. |
| UX | UX scope is information architecture, status vocabulary, and customer-safe wording for future publisher-facing flows, not screens, routing, forms, trust badges, storefronts, or design-system implementation. |
| Security | Security scope records required identity, provenance, SBOM, vulnerability, conformance, and review evidence before customer-visible claims can appear, without implementing scanners, RBAC enforcement, policy engines, or credential handling. |
| Support | Support receives rejection, yank, escalation, payout-blocked, and unsupported-state wording with owner routes; support queues, SLAs, incident communications, and ticket automation remain separate. |

## Publisher Portal States

| State | Meaning |
|---|---|
| `draft-profile` | Publisher profile is incomplete and cannot support review or launch claims. |
| `identity-pending` | Publisher identity, contact, or ownership evidence is not accepted yet. |
| `evidence-required` | Required listing, provenance, SBOM, conformance, security, warning, or support evidence is missing. |
| `ready-for-review` | Submission evidence is complete enough to enter Capability Review & Approval. |
| `limited-beta-visible` | Listing may appear only with limited-beta wording from review evidence. |
| `installable-visible` | Listing may appear as installable only with provenance, conformance, security review, and catalog approval evidence. |
| `rejected` | Listing is blocked from installability claims and routes to the review owner. |
| `yanked` | Previously accepted listing is removed from new selection and routes to support or migration guidance. |
| `payout-readiness-blocked` | Payout-adjacent status is blocked by Marketplace Payout Hooks evidence or unsupported state. |
| `support-escalated` | Customer-facing state requires a named support or release owner before claims change. |

## Authoritative Dependencies

- [Marketplace publisher trust evidence](./marketplace-publisher-trust-evidence.md) defines
  publisher trust tiers, required evidence, unsupported claims, and customer-visible limitations.
- [Capability Review & Approval](./capability-review-approval.md) defines review states, approval
  outcomes, yanking, escalation, and rating-signal boundaries.
- [Marketplace Payout Hooks](./marketplace-payout-hooks.md) defines payout-readiness states and
  tax/identity handoffs that the portal may show without taking payout execution scope.
- [Org Catalogs](./org-catalogs.md) defines org catalog approvals and private listing boundaries
  consumed by publisher listing visibility.
- [Billing Launch Policy](./billing-launch-policy.md) defines commercial billing boundaries while
  keeping pricing, invoices, payment providers, refunds, and credits out of this issue.
- [Launch Support Escalation](./launch-support-escalation.md) defines customer-safe support
  escalation and gap-routing posture for rejected, yanked, escalated, and unsupported states.
- [ADR-0062](./adr/07-portability-extensibility.md#adr-0062) pins Registry distribution as signed,
  certified artifacts rather than ad hoc portal publishing.
- [ADR-0074](./adr/02-identity-security.md#adr-0074) pins org governance and mandatory policy as
  dependencies for publisher and maintainer authority.
- [ADR-0064](./adr/07-portability-extensibility.md#adr-0064) keeps monetization mechanics outside
  HoBo's meta-cloud core.

## Owning Initiative Dependencies

| Owner | Consumes from Publisher Portal | Boundary |
|---|---|---|
| Publisher Portal | Accepted publisher profile, maintainer role, submission evidence, status projection, and follow-up gate. | This issue defines M0 scope and acceptance; it does not build the portal UI or backend. |
| Capability Review & Approval | Review outcomes, evidence requests, approvals, rejections, yanks, and escalation states for portal status projection. | Review queues, approval service behavior, and security decisioning remain in Capability Review & Approval. |
| Marketplace Publisher Trust Evidence | Trust-tier evidence and unsupported-claim wording for publisher-facing listing status. | Trust-tier policy and evidence validation remain in Marketplace Publisher Trust Evidence. |
| Marketplace Payout Hooks | Payout-readiness and blocked-reason handoffs for future publisher-facing display. | Payout execution, tax documents, provider integration, and settlement stay outside Publisher Portal. |
| Org Catalogs | Publisher and listing status when private catalog approval and org visibility decisions are later designed. | Catalog approval workflow, policy enforcement, and Registry handoff remain Org Catalogs. |
| Billing & Credits | Billing-contact and commercial-boundary handoffs without the portal building invoices or payments. | Plans, invoices, payments, refunds, credits, and billing reconciliation remain Billing & Credits. |
| Support Workflow | Rejected, yanked, escalated, unsupported, and payout-blocked owner routes for customer-safe support. | Support queues, SLAs, automation, and incident communications stay outside this issue. |
| V1 Release Program & Cutline | Accepted M0 scope for deciding when M1-M4 publisher portal follow-up issues can be created. | Release go/no-go, cutline decisions, and downstream issue creation remain release-program scope. |

## Evidence Required For M1

| Evidence | Owner | Source | Proof mode | Proves |
|---|---|---|---|---|
| Publisher profile fixture | Publisher owner | Publisher profile and maintainer records | Reference fixture | Publisher organization identity, contacts, ownership, and support route fields are explicit before portal implementation begins. |
| Maintainer permission matrix | Publisher maintainer | Publisher profile and maintainer records | Design record | Maintainer roles are named without granting review, policy, billing, payout, or support authority. |
| Submission evidence envelope | Security reviewer | Listing submission evidence envelope | Contract test | Listing submissions name provenance, capability spec, SBOM, vulnerability, conformance, warning, and support evidence. |
| Review status projection | Marketplace operator | Capability Review & Approval review states | Contract test | Portal-visible statuses are projections of review decisions, not independent portal decisions. |
| Payout readiness handoff | Marketplace operator | Marketplace Payout Hooks payout states | Design record | Payout readiness appears only as a handoff state with blocked reasons and owner route. |
| Support escalation handoff | Support operator | Launch support escalation | Support handoff | Rejected, yanked, escalated, and unsupported states include customer-safe wording and support owner routes. |
| Scope boundary register | Release owner | Scope out and non-goals | Release gate | Portal UI, review service, Registry storage, payout, billing, support, and follow-up scope stays blocked until M0 acceptance. |

## Follow-Up Gate

M1/M2/M3/M4 design or implementation issues must wait until this M0 scope record is accepted. This
branch records the gate and its executable guard; it does not create follow-up implementation
issues.
