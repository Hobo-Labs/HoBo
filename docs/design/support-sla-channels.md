---
type: Reference
title: "Support SLA Channels Scope And Acceptance"
description: "Source issue: HOBO-496."
tags: [hobo, design]
---

# Support SLA Channels Scope And Acceptance

Source issue: HOBO-496.

Executable proof lives in
[`src/draft/exp-proofs/cx/support-sla-channels-contract`](../../src/draft/exp-proofs/cx/support-sla-channels-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-496-support-sla-channels`](./proofs/hobo-496-support-sla-channels/README.md).

## M0 Acceptance Record

Support Workflow needs an accepted v1 support SLA and channel coverage record before beta or GA
support promises can become customer-facing. This record defines support channels, support hours,
response target language, severity routing, handoff rules, unsupported request classes, and the
owner gate for contractual SLA language. It does not implement support tooling, approve commercial
terms, or promise public response times.

## User And Business Goal

HoBo needs support coverage that release owners, customer admins, support operators, incident
commanders, and security reviewers can reason about before launch. The accepted record should make
three things explicit: what support can say during beta, what remains only an internal operational
target, and what cannot be published as a GA customer commitment without business-owner approval and
accepted evidence.

## Primary Personas

| Persona | Need |
|---|---|
| Support lead | Needs accepted channel coverage, staffing assumptions, severity routing, and unsupported-request policy before beta support starts. |
| Support operator | Needs customer-safe response targets, handoff rules, evidence requirements, and escalation owners for each request class. |
| Customer admin | Needs clear channel availability, beta limitations, unsupported requests, and escalation expectations without hidden SLA guarantees. |
| Incident commander | Needs support-to-incident handoff rules that align ticket intake, customer communications, and incident records. |
| Release owner | Needs launch cutline decisions for support coverage gaps and customer-facing commitment language. |
| Security/compliance reviewer | Needs escalation, redaction, audit, and business-owner approval boundaries before contractual support language is published. |

## Scope In

- Define supported channels, support hours, beta coverage assumptions, and unsupported channel
  states.
- Define response target language for internal operations, beta promises, and GA customer-facing
  commitments.
- Map severity routing, handoff rules, evidence requirements, and owner lanes for SEV0 through
  SEV3 support intake.
- Record unsupported request classes and their safe owner routes.
- Link support SLA/channel decisions to incident communications, admin console visibility, and
  release cutline ownership.
- List M1 evidence required before support workflow implementation or public SLA publication work
  can begin.

## Scope Out And Non-Goals

- Do not approve contractual SLA language, paid support tier promises, or public response
  guarantees without business owner signoff.
- Do not build support tooling, ticket queue automation, helpdesk integration, admin console UI, or
  status-page publishing workflows.
- Do not implement incident command automation, on-call schedules, runbook execution, or
  notification dispatch.
- Do not approve legal terms, procurement agreements, enterprise support contracts, or commercial
  pricing.
- Do not run live customer support operations, grant customer data access, or schedule production
  support staff.
- Do not create downstream M1-M4 implementation issues before this M0 record is accepted.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Support Workflow M0 owns support channel coverage, response language, unsupported-request routing, and M1 proof expectations. Support desk services are later work. |
| UX | UX scope is the future information architecture for support channels, limitations, and customer-safe target language, not a rendered support portal. |
| Security | Security scope requires redaction, audit, customer-data, and business-owner approval boundaries before customer-facing SLA language is published. |
| Support | Support consumes severity, channel, handoff, unsupported-request, and owner-route evidence without adding live queues or staffing workflows. |

## Support Channels And Hours

| Channel | Availability | Customer visible | Evidence |
|---|---|---|---|
| Support ticket | Beta business-hours intake; GA coverage requires owner approval. | Yes | Ticket intake fixture with severity and owner fields. |
| Status page | Customer-impacting incident updates only after redaction and incident evidence. | Yes | Incident communication template linked to HOBO-408. |
| Launch room | Internal launch stakeholder coordination during beta and release cutline review. | No | Launch-room handoff note with owner and next decision. |
| Customer email | Approved customer communication for named affected accounts. | Yes | Redacted email template with incident or support ticket source. |
| Docs FAQ | Approved answer and limitation source for SEV3 questions and unsupported states. | Yes | Docs/support FAQ entry or release-note limitation. |

## Response Targets And Severity Routing

| Severity | Support hours | Internal target | Beta promise | Handoff rule |
|---|---|---|---|---|
| SEV0 | 24x7 internal interrupt target during launch windows only. | Immediate internal triage and incident commander handoff. | Customer acknowledgement after impact and communication owner are confirmed. | Escalate to Incident Communications and V1 Release Program when impact is customer-visible or unclear. |
| SEV1 | Launch-window coverage plus next business-day owner review. | Same launch-window routing to support lead and owning operator lane. | Support ticket update when workaround, owner, or next update condition is known. | Escalate to Incident Communications if customer-visible; otherwise route to Support Workflow owner. |
| SEV2 | Business-hours beta support. | Triage to product, admin console, docs, or support owner within the beta support window. | Best-effort ticket update with limitation, workaround, or follow-up owner. | Escalate to Admin Console when missing tenant, entitlement, project, or environment context blocks support. |
| SEV3 | Business-hours documentation and launch-readiness routing. | Answer from approved material or file a readiness gap. | No operational response commitment beyond approved beta support material. | Escalate to V1 Release Program & Cutline when the answer changes launch readiness or public claims. |

## SLA Language Boundary

| Mode | Customer facing | Contractual | Rule |
|---|---|---|---|
| Internal target | No | No | Internal targets guide staffing and triage; they are not quoted externally. |
| Beta promise | Yes | No | Beta promises are customer-visible limitations backed by accepted evidence, not contractual SLA guarantees. |
| GA customer commitment | Yes | Yes | GA customer-facing commitments require accepted evidence and explicit business-owner signoff before publication. |

## Unsupported Request Classes

| Request class | Owner | Customer-safe message |
|---|---|---|
| Contractual SLA negotiation | Business Owner / Legal | Contractual support terms are not self-approved by support. |
| Custom production data access | Security Verification / Legal | Support cannot access customer data without an approved security and legal path. |
| Unsupported install environment | Bootstrap Installer | Unsupported environments route to installer limitations and troubleshooting evidence. |
| Unproven backup/restore claim | Backup & Restore | Restore readiness requires accepted drill evidence before support can claim it. |
| Release cutline exception | V1 Release Program & Cutline | Launch exception requests route to the release owner before support promises change. |

## Escalation Links

| Owner | Source | Consumes | Boundary |
|---|---|---|---|
| Support Workflow | This record | Channel coverage, response language, unsupported-request routing, and follow-up gate. | Ticket queues, staffing workflows, and helpdesk integrations remain later support implementation work. |
| Incident Communications | [launch-support-escalation.md](./launch-support-escalation.md) | SEV0/SEV1 customer-visible incident handoff and status-page redaction rules. | Incident communication templates and publication workflows remain governed by the HOBO-408 escalation record. |
| Admin Console | [member-rbac-administration.md](./member-rbac-administration.md) | Tenant, project, entitlement, role, and environment visibility gaps that block support triage. | Admin console UI, RBAC changes, and tenant-data access stay out of this issue. |
| V1 Release Program & Cutline | [release-notes-upgrade-guide.md](./release-notes-upgrade-guide.md) | Public commitment language, beta limitation wording, and launch-readiness exceptions. | Release go/no-go and customer-facing terms approval stay with release and business owners. |

## Evidence Required For M1

| Evidence | Owner | Proof mode | Proves |
|---|---|---|---|
| Support model record | Support lead | Design record | Channels, hours, severity routes, handoff rules, and unsupported classes are accepted. |
| Channel coverage table | Support operator | Reference fixture | Each support channel names availability, customer visibility, and evidence source. |
| Response language register | Release owner | Policy fixture | Internal targets, beta promises, and GA commitments are separated before publication. |
| Escalation integration fixture | Incident commander | Support handoff | Support, incident communication, admin console, and release cutline handoffs have owners. |
| Unsupported request router | Security/compliance reviewer | Contract test | Unsupported requests route to the correct owner instead of becoming silent promises. |
| Owner signoff gate | Business owner | Approval record | Contractual SLA publication remains blocked until evidence and business-owner signoff exist. |

## Follow-Up Gate

Create M1/M2/M3/M4 support SLA, channel, tooling, or publication work only after this M0 scope
record and executable proof are accepted. Until then, this branch proves readiness shape and scope
guards, not production support capability.
