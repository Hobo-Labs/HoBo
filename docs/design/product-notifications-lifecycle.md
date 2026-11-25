---
type: Reference
title: "Product Notifications And Lifecycle Communications"
description: "Source issue: HOBO-506."
tags: [hobo, design]
---

# Product Notifications And Lifecycle Communications

Source issue: HOBO-506.

Executable proof lives in
[`src/draft/technical-proofs/product-notification-taxonomy-contract`](../../src/draft/technical-proofs/product-notification-taxonomy-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-506-product-notification-taxonomy`](./proofs/hobo-506-product-notification-taxonomy/README.md).

## M0 Acceptance Record

Product notifications exist so HoBo can send required v1 lifecycle messages with a named owner,
customer-safe copy, support-visible delivery evidence, and explicit preference boundaries. This
record does not implement an email service, SMS/push/webhook provider, notification center, status
page, incident communication workflow, or marketing campaign system.

## Required Notification Classes

| Class | Channels | Owner project | Copy owner | Trigger source | Support/audit visibility |
|---|---|---|---|---|---|
| Workspace invite | Email, in-app | Workspace & Onboarding UX | Workspace onboarding copy owner | Invite created | Invite id, principal ref, sender workspace, and delivery outcome. |
| Account lifecycle | Email, in-app | Settings & Project Lifecycle | Account lifecycle copy owner | Account, workspace, or project lifecycle state change | Lifecycle event id, affected workspace/project, state, and delivery outcome. |
| Onboarding nudge | In-app, email | Workspace & Onboarding UX | First-run product copy owner | Activation rail stalled or next action available | Nudge category, activation stage, opt-out state, and delivery result. |
| Deployment status | In-app, webhook, email | Deployment Dashboard & Topology Explorer | Deployment status copy owner | Deployment status, plan approval, rollback, or blocker event | Deployment id, environment, blocker class, and rollback/support evidence link. |
| Billing and entitlement | Email, in-app | Billing & Credits | Billing launch policy owner | Billing lifecycle, invoice, credit, entitlement, or payment state change | Customer-safe billing state, entitlement impact, and invoice evidence reference. |
| Marketplace and publisher lifecycle | In-app, email | Marketplace UX | Marketplace trust and publisher copy owner | Publisher trust, listing review, yank, install approval, or org catalog update | Listing id, publisher id, trust tier, warning, and delivery result. |
| Support handoff and lifecycle follow-up | Email, in-app | V1 Launch Support Desk & Escalation | Support communications owner | Support handoff, readiness gap, accepted limitation, or follow-up owner change | Handoff reason, owner lane, ticket or incident id, and delivery result. |

## Preferences And Consent

Transactional classes are workspace invite, account lifecycle, deployment status, and billing or
entitlement notices. They must still be customer-safe and supportable, but cannot be silently
disabled when needed for account, security, billing, or deployment state.

Optional classes are onboarding nudge, marketplace/publisher lifecycle, and support handoff
follow-up. These require an opt-out path through workspace settings, profile notification
preferences, or a support override record. Consent wording, privacy notice, retention disputes, and
regional messaging limits route to V1 Legal, Privacy & Terms Readiness.

## Delivery Evidence Strategy

| Evidence area | M0 expectation |
|---|---|
| Mocked email provider | Deterministic accepted, bounced, failed, and delayed fixtures; no live SMTP, SES, SendGrid, Mailgun, or stored provider credential. |
| Mocked in-app renderer | Template/render fixture plus read-state fixture; no notification-center or dashboard implementation. |
| Mocked webhook gateway | Signed fixture responses and retry outcomes; no live outbound webhook execution or customer endpoint storage. |
| Failure handling | Bounces, failures, and delayed delivery record class, channel, fixture reason, retry state, owner lane, and customer-safe support evidence. |
| Dedupe | Idempotency key is notification class plus trigger source id plus principal ref plus channel; duplicate provider callbacks converge on one outcome. |
| Retry | Bounded deterministic retry stops after bounce, opt-out, legal hold, or missing template approval. |
| Audit trail | Uses `notification.Requested`, `notification.Delivered`, `notification.Bounced`, and `notification.Failed`; recipient addresses are references, not plaintext audit fields. |
| Customer-safe templates | Lifecycle, billing/entitlement, and deployment-status templates require review owner, redaction gate, required fields, and support reference. |

## Scope Out And Non-Goals

- Do not implement incident communications or replace the Launch Support Escalation matrix.
- Do not implement public status-page publication or subscriber update workflows.
- Do not implement marketing campaigns, newsletters, or nurture automation.
- Do not build a post-v1 notification-center product surface.
- Do not integrate live email, SMS, push, webhook, or provider delivery services.

## Authoritative Dependencies

- [Plan 11](./data-plane.md#plan-11) defines the `notification.*` audit events and event-sourced
  delivery facts.
- [ADR-0059](./adr/03-data-plane.md#adr-0059) defines one `hobo:notify` capability behind channel
  types and keeps delivery idempotent and auditable.
- [launch-support-escalation.md](./launch-support-escalation.md) owns incident communications,
  severity routing, and support escalation templates.
- [billing-launch-policy.md](./billing-launch-policy.md) owns billing and entitlement lifecycle
  states that trigger customer-visible notices.
- [workspace-onboarding-ux.md](./workspace-onboarding-ux.md) owns first-run activation context and
  onboarding nudge boundaries.

## Evidence Required For M1

| Evidence | Owner | Proof mode | Proves |
|---|---|---|---|
| Notification class fixture | Product Notifications & Lifecycle Communications | Contract test | Required v1 classes have owner, channel, trigger, copy, support, and audit fields. |
| Preference policy fixture | Product Notifications & Lifecycle Communications | Contract test | Transactional and optional classes are distinct, and optional messages require opt-out support. |
| Mock provider fixture | Product Notifications & Lifecycle Communications | Contract test | Delivery can be tested with bounced, failed, delayed, duplicate, and accepted outcomes without live providers. |
| Template review matrix | Product copy owners | Design record | Customer-safe templates have review owner, redaction gate, required fields, and support reference. |
| Support evidence handoff | V1 Launch Support Desk & Escalation | Support handoff | Support can explain message status, owner, next action, and delivery evidence without provider secrets. |

## Follow-Up Gate

M1/M2/M3/M4 design or implementation issues must wait until this M0 taxonomy and delivery-boundary
record is accepted. This branch records the gate and executable guard; it does not create delivery
provider, notification-center, status-page, incident-communication, or marketing implementation work.
