---
type: Reference
title: "Incident Communications Scope And Acceptance"
description: "Source issue: HOBO-450."
tags: [hobo, design]
---

# Incident Communications Scope And Acceptance

Source issue: HOBO-450.

Executable proof lives in
[`src/draft/exp-proofs/cx/incident-communications-scope-contract`](../../src/draft/exp-proofs/cx/incident-communications-scope-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-450-incident-communications`](./proofs/hobo-450-incident-communications/README.md).

## M0 Acceptance Record

Incident Communications defines the v1 customer-safe incident update boundary for state vocabulary,
templates, communication surfaces, redaction gates, support handoffs, and follow-up issue gating. It
does not build live notification dispatch, public status-page publishing, support ticket automation,
contractual SLA enforcement, runbook execution, or customer-data-bearing communication payloads.

## User And Business Goal

HoBo needs accepted M0 scope for Incident Communications before customer-visible incident updates,
status-page communication, support handoffs, or launch limitation notes can depend on it. The
accepted record tells incident commanders, support leads, customer administrators, SRE operators,
release owners, and security/compliance reviewers which incident states exist, which templates are
allowed, which owners consume the result, and which adjacent initiatives remain out of scope.

## Primary Personas

| Persona | Need |
|---|---|
| Incident commander | Coordinate factual incident state, next update cadence, and internal approval without owning live publication tooling. |
| Support lead | Receive customer-safe update language and escalation handoffs without turning this scope into ticket automation or SLA enforcement. |
| Customer administrator | Understand service impact, current state, mitigation guidance, and expected follow-up without seeing private tenant data. |
| SRE operator | Provide verified incident facts and runbook status while keeping remediation execution in SRE-owned lanes. |
| Release owner | Gate launch communication claims on accepted incident-communication evidence and limitation wording. |
| Security and compliance reviewer | Verify redaction, customer-data exclusion, incident evidence, and auditability before customer-visible publication. |

## Scope In

- Customer-safe incident communication vocabulary for candidate, investigating, identified,
  monitoring, resolved, and follow-up states.
- Template taxonomy for initial notices, progress updates, maintenance notices, resolution
  summaries, and limitation notes.
- Service, UX, security, and support boundaries for status-page, named-customer, support-ticket,
  launch-room, and release-note communication handoffs.
- Evidence checklist for source incident facts, redaction approval, owner review,
  status/state mapping, and support handoff before customer-visible updates.
- Follow-up gate that blocks M1-M4 design or implementation issues until this M0 scope record is
  accepted.

## Scope Out And Non-Goals

- Do not build live notification dispatch, email/SMS/webhook delivery, subscription management, or a
  preference center.
- Do not build a public status page renderer, component uptime computation, status-page publishing
  workflow, or external incident feed.
- Do not build support ticket automation, queue routing, CRM integration, or contractual support SLA
  enforcement.
- Do not build runbook execution, remediation automation, rollback operation, or SRE control-plane
  mutation.
- Do not include customer-private data, tenant data, customer_email fields, or raw diagnostic
  payloads in customer-visible communication templates.
- Do not create downstream M1-M4 design or implementation issues before M0 scope is accepted.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Incident Communications defines records, templates, state vocabulary, and handoff evidence; it does not build dispatch services, status-page renderers, support queues, or runbook executors. |
| UX | UX scope is customer-safe copy structure, state labels, update cadence language, and limitation wording for later surfaces; no screen, feed, email, or notification UI is implemented here. |
| Security | Security scope requires redaction approval, customer-data exclusion, source evidence, and auditability before customer-visible publication. |
| Support | Support receives escalation context, customer-safe wording, and owner handoff records; ticket automation, SLA guarantees, queue routing, and CRM mutation remain out of scope. |

## Communication Surfaces

| Surface | Owner | Boundary |
|---|---|---|
| Public status page | Public Status Page | Consumes approved incident update records; publication workflow and component uptime logic stay outside HOBO-450. |
| Named-customer update | Support Workflow | Consumes customer-safe copy and incident facts; delivery, account selection, and ticket activity stay outside HOBO-450. |
| Support-ticket handoff | Support SLA & Channels | Receives escalation context and state labels; ticket creation, routing, and SLA enforcement stay outside HOBO-450. |
| Internal launch room | Release Program | Uses limitation and launch-claim status; release go/no-go remains release-program scope. |
| Release-notes limitation | Launch Messaging Claims | Uses resolved/follow-up summaries and limitations; public launch copy approval remains launch-messaging scope. |

## Incident State Vocabulary

| State | Meaning |
|---|---|
| `candidate` | Potential customer-impacting event is being assessed and is not customer-visible by default. |
| `investigating` | Impact is plausible or confirmed and facts are still being gathered. |
| `identified` | Cause or affected boundary is known enough to state a mitigation or owner. |
| `monitoring` | Mitigation is applied and stability evidence is being watched. |
| `resolved` | Customer-impacting incident is no longer active and summary evidence can be prepared. |
| `follow-up` | Post-incident customer-safe action item, limitation, or postmortem reference remains open. |

## Template Kinds

| Template | Required fields | Gate |
|---|---|---|
| Initial notice | `communication_id`, `incident_state`, `customer_impact`, `next_update_expectation` | Redaction approved. |
| Progress update | `communication_id`, `incident_state`, `current_status`, `next_update_expectation` | Redaction approved. |
| Maintenance notice | `communication_id`, `maintenance_window`, `expected_customer_impact`, `rollback_statement` | Redaction approved. |
| Resolution summary | `communication_id`, `incident_state`, `resolution_time`, `customer_safe_summary` | Redaction approved. |
| Limitation note | `communication_id`, `known_limitation`, `owner_route`, `follow_up_expectation` | Redaction approved. |

## Publication Gate

Customer-visible incident communication requires accepted incident evidence, redaction approval, no
customer data, and no contractual SLA language. Internal communication can use the record without the
customer-visible publication gate, but still inherits the scope boundary.

## Authoritative Dependencies

- [Launch Support Escalation](./launch-support-escalation.md) defines incident communication
  templates, escalation handoffs, and launch support gap routing consumed by this scope.
- [Public Status Page & Incident Communication](./public-status-page-incident-communication.md)
  defines public status-page component taxonomy, incident states, maintenance notices, update cadence,
  and publication boundaries.
- [Support SLA & Channels](./support-sla-channels.md) defines support channel coverage,
  response-target language, unsupported request routing, and owner signoff boundaries.
- [Product Notifications and Lifecycle Communications](./product-notifications-lifecycle.md)
  defines product lifecycle notification classes, preference/delivery evidence, and notification
  ownership boundaries.
- [Launch Messaging Claims](./launch-messaging-claims.md) defines launch claims, limitation copy,
  evidence owners, and publication review requirements.
- [ADR-0045](./adr/02-identity-security.md#adr-0045) pins SLO-as-code, alerting, and rollback
  calibration as reliability-owned sources for incident facts.
- [ADR-0058](./adr/03-data-plane.md#adr-0058) pins SRE incident management, runbooks, diagnosis, and
  gated remediation as operator-owned inputs.

## Owning Initiative Dependencies

| Owner | Consumes from Incident Communications | Boundary |
|---|---|---|
| Incident Communications | Accepted communication vocabulary, templates, redaction gates, evidence checklist, and follow-up issue gate. | Defines M0 scope and acceptance; does not implement dispatch, publication, support, or remediation runtime. |
| Public Status Page | Incident states, update records, maintenance notices, and limitation summaries. | Status page publication, component uptime, and public feed behavior remain Public Status Page scope. |
| Support SLA & Channels | Support-safe incident wording, escalation context, and unsupported-request routes. | Response targets, ticket queues, CRM mutation, and SLA policy remain Support SLA & Channels scope. |
| Operators/SRE | Source incident facts, remediation state, rollback status, and runbook references. | Diagnosis, remediation, rollback, and runbook execution remain Operators/SRE scope. |
| Security Verification / Legal | Redaction, customer-data exclusion, compliance-sensitive language, and disclosure constraints. | Legal approval workflow, vulnerability disclosure, and tenant data policy remain separate owner lanes. |
| Launch Messaging Claims | Resolved incident summaries and limitation notes before public launch or release-note claims. | Launch-site copy, public claim approval, and demo asset publication remain launch-messaging scope. |

## Evidence Required For M1

| Evidence | Boundary | Owner | Proves |
|---|---|---|---|
| Incident-state fixture | Service | Incident commander | Later services can distinguish candidate, investigating, identified, monitoring, resolved, and follow-up states. |
| Template-schema fixture | Service | Incident commander | Every communication template has `communication_id` and redaction-gated required fields. |
| Customer-copy review | UX | Release owner | Customer-visible status, named-customer, support, launch-room, and release-note surfaces have distinct copy boundaries. |
| Redaction-approval fixture | Security | Security/compliance reviewer | Customer-visible communication requires evidence, redaction approval, and no customer data leakage. |
| Support-handoff register | Support | Support lead | Support receives handoff context without ticket automation, SLA enforcement, or queue mutation. |
| Scope-boundary register | Support | Release owner | Live notification dispatch, status-page implementation, ticket automation, runbook execution, SLA promises, and customer data remain out. |

## Follow-Up Gate

M1/M2/M3/M4 incident template, status-page, named-customer update, support handoff, notification,
launch-room, release-note, redaction, and proof issues must wait until this M0 scope record is
accepted. This branch records the gate and executable guard; it does not create follow-up
implementation issues.
