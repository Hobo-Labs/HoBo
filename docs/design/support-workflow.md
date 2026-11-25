---
type: Reference
title: "Support Workflow Scope And Acceptance"
description: "Source issue: HOBO-448."
tags: [hobo, design]
---

# Support Workflow Scope And Acceptance

Source issue: HOBO-448.

Executable proof lives in
[`src/draft/exp-proofs/cx/support-workflow-scope-contract`](../../src/draft/exp-proofs/cx/support-workflow-scope-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-448-support-workflow`](./proofs/hobo-448-support-workflow/README.md).

## M0 Acceptance Record

Support Workflow needs an accepted intake, triage, evidence, owner-route, and customer-safe handoff
record before support tooling or live operations can become implementation work. This record defines
support request states, required support evidence, owner handoffs, redaction/access boundaries, M1
proof expectations, and scope guards. It does not implement helpdesk software, ticket queues,
customer-data access, incident command, on-call, runbook execution, or contractual SLA language.

## User And Business Goal

HoBo needs a support workflow that release owners, support operators, customer admins, incident
commanders, and security reviewers can reason about before beta. The accepted record should make
three things explicit: how support requests move from receipt to owner-routed closure, what evidence
is safe to expose, and which adjacent initiatives own work that is not support workflow scope.

## Primary Personas

| Persona | Need |
|---|---|
| Support lead | Needs accepted workflow ownership, severity triage, and follow-up gates before support execution issues fan out. |
| Support operator | Needs a customer-safe intake record, required evidence fields, and owner-route rules for each request. |
| Customer admin | Needs clear support handoff language, next-update conditions, and limitation wording without hidden SLA guarantees. |
| Incident commander | Needs a support-to-incident handoff that preserves redacted context and does not replace incident command ownership. |
| Release owner | Needs launch-readiness gaps and customer-facing support language routed into the release cutline. |
| Security/compliance reviewer | Needs customer-data, redaction, audit, and access boundaries before support work can expose operational evidence. |

## Scope In

- Define support intake, triage, owner routing, customer-safe status, and closure vocabulary.
- Record required support evidence fields for requester, summary, severity, affected surface, owner
  route, linked evidence, redaction state, and next update condition.
- Map service, UX, security, and support boundaries across Admin Console, Incident Communications,
  Support SLA Channels, Release Program, Security Verification, and Docs.
- Define M1 evidence required before support tooling, ticket queue integration, or customer-support
  operations work can begin.
- Define customer-safe handoff language for unsupported, blocked, and owner-routed requests.

## Scope Out And Non-Goals

- Do not implement helpdesk software, ticket queue automation, support portal UI, status-page
  publishing, or live support operations.
- Do not grant production customer data access, secret access, tenant data browsing, or support
  impersonation.
- Do not approve contractual SLA language, public response-time guarantees, paid support tiers, or
  GA support terms.
- Do not replace incident command, implement on-call schedules, execute runbooks, or dispatch
  notifications.
- Do not create downstream M1-M4 implementation issues before this M0 record is accepted.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Support Workflow M0 owns intake, triage states, owner routing, customer-safe evidence shape, and M1 proof expectations. Runtime support services are later work. |
| UX | Support Workflow and Admin Console may later expose status, owner route, limitations, and next-update conditions; this M0 record defines information architecture only. |
| Security | Security Verification and Legal own redaction, customer-data access, audit, and approval boundaries before support can expose operational evidence. |
| Support | Support consumes launch support, SLA/channel, admin-console, release, and security evidence without adding live queues or staffing workflows. |

## Intake States

| State | Meaning |
|---|---|
| Received | A request arrives with requester and channel context, but severity and owner are not yet accepted. |
| Classified | Severity, affected surface, and unsupported-request posture are assigned from accepted records. |
| Evidence linked | Redacted evidence links, incident/support references, and source records are attached. |
| Owner routed | The owning initiative accepts the next action or handoff boundary. |
| Customer updated | Customer-safe wording, limitation, and next update condition are recorded. |
| Closed | The request has a routed answer, follow-up issue, or accepted unsupported-state explanation. |

## Required Support Evidence

| Field | Owner | Proof |
|---|---|---|
| Requester | Support Workflow | Identifies customer, admin, internal operator, or release stakeholder requesting support. |
| Customer-safe summary | Support Workflow | Summarizes the request without raw secrets, internal-only incident notes, or customer data leakage. |
| Severity | Support SLA Channels | Maps the request to accepted SEV0-SEV3 handling language. |
| Affected surface | Admin Console / Product Owner | Names product, tenant, project, environment, release, or docs surface involved. |
| Owner route | Support Workflow | Names the next responsible initiative and support boundary. |
| Evidence links | Owning Initiative | Links redacted logs, incident record, admin context, release note, proof package, or docs source. |
| Redaction state | Security Verification | States whether evidence is customer-safe, internal-only, or requires security/legal approval. |
| Next update condition | Support Workflow | Records when support updates the customer or internal stakeholder again. |

## Owning Initiative Dependencies

| Owner | Boundary |
|---|---|
| Support SLA Channels | Supplies channel, severity, target-language, unsupported-request, and owner-signoff vocabulary; Support Workflow consumes it for triage. |
| Incident Communications | Owns public incident updates, status-page templates, and incident-command handoff; Support Workflow only routes and links customer-safe state. |
| Admin Console | Supplies tenant, entitlement, project, environment, and release visibility; Support Workflow does not build admin UI or authorize data access. |
| Security Verification | Owns redaction, access approval, and customer-data exposure boundaries before support evidence becomes customer-visible. |
| V1 Release Program & Cutline | Owns public commitment language, beta limitation wording, and go/no-go exceptions surfaced by support gaps. |
| Docs / Troubleshooting Guides | Owns approved answers and troubleshooting content that support may cite for SEV3 and unsupported states. |

## Evidence Required For M1

| Evidence | Owner | Proof mode | Proves |
|---|---|---|---|
| Support intake schema | Support lead | Design record | Support request, channel, requester, severity, affected surface, and owner route fields are stable. |
| Triage state machine | Support operator | Contract test | Received, classified, evidence-linked, owner-routed, customer-updated, and closed states transition deterministically. |
| Customer-safe evidence pack | Security/compliance reviewer | Support handoff | Support can attach redacted logs, incidents, admin context, docs, and proof links without leaking secrets. |
| Owner-route matrix | Release owner | Reference fixture | Support, incident communications, admin console, security, release, docs, billing, bootstrap, and backup cases route to owners. |
| Redaction and access guard | Security/compliance reviewer | Policy fixture | Raw customer data, secret access, impersonation, and internal incident notes fail closed without approval. |
| Scope boundary register | Support lead | Audit fixture | Helpdesk automation, SLA promises, incident command, support staffing, and live operations remain out of M0 scope. |

## Follow-Up Gate

Create M1/M2/M3/M4 Support Workflow design or implementation work only after this M0 scope record
and executable proof are accepted. Until then, this branch proves readiness shape and scope guards,
not production support capability.
