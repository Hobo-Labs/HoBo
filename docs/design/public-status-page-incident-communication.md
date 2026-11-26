---
type: Reference
title: "Public Status Page Incident Communication Contract"
description: "Source issue: HOBO-497."
tags: [hobo, design]
---

# Public Status Page Incident Communication Contract

Source issue: HOBO-497.

Executable proof lives in
[`src/draft/technical-proofs/public-status-page-incident-communication-contract`](../../src/draft/technical-proofs/public-status-page-incident-communication-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-497-public-status-page-incident-communication`](./proofs/hobo-497-public-status-page-incident-communication/README.md).

## M0 Acceptance Record

Customers need one consistent public place and language for launch incidents,
maintenance, degraded service, and resolution follow-up. This record defines the
public status-page contract and incident-communication shape. It does not build
live status-page publishing, subscriber management, notification delivery,
support tooling, runbook execution, or customer-facing response SLA promises.

## Status Page Scope

| Area | Includes | Excludes |
|---|---|---|
| Public components | Customer-readable component groups, current status, degraded capability labels, and owning readiness domain. | Raw provider topology, private tenant identifiers, internal host names, and debug-only runbook state. |
| Active incidents | Public incident summary, affected components, state, last update, next update condition, and customer-safe impact language. | Unredacted incident timeline, responder notes, private support tickets, and speculative root cause. |
| Planned maintenance | Maintenance window, expected customer impact, affected components, rollback posture, and cancellation/completion updates. | Change execution automation, deploy pipeline implementation, and direct provider maintenance orchestration. |
| History and subscriptions | Launch-safe incident history, maintenance history, subscription handoff expectations, and retention/visibility boundaries. | Live subscriber management, notification delivery service, and customer-specific incident exports. |

## Component Taxonomy

| Component | Owner lane | Evidence source |
|---|---|---|
| Control Plane API | Operators/SRE | Control-plane availability and deploy API health. |
| Deployments and Planner | Reliability/observability/cost | Deploy success rate, queue saturation, and rollback/compensation evidence. |
| Identity and Auth | Security | Token broker, issuer, session, and auth-port health evidence. |
| Runtime Camps | Runtime operations | Camp runtime availability, workload execution, and per-Camp degraded labels. |
| Docs and Support | Support | Docs portal, support intake, and customer communication readiness. |

## Incident And Maintenance States

| State | Customer-safe meaning | Required evidence |
|---|---|---|
| Investigating | HoBo has confirmed a possible customer-visible issue and is gathering evidence. | Incident record or support/customer report with affected component candidate. |
| Identified | HoBo has identified the affected component or mitigation path. | Incident timeline or responder note approved for customer-safe wording. |
| Monitoring | A mitigation is applied and HoBo is watching recovery evidence. | Mitigation event, SLO/health evidence, or support verification note. |
| Resolved | Customer-visible impact has ended or the maintenance event is complete. | Resolved incident record or approved maintenance completion evidence. |

Maintenance notices use `scheduled`, `in-progress`, `completed`, and `canceled`
states. Each notice must name the maintenance window or incident ID, affected
components, current status, next update condition, and completion/cancellation
summary when known.

## Update Cadence

| State | Update rule |
|---|---|
| Investigating | Update when scope, affected component, workaround, or next-update condition changes. |
| Identified | Update when mitigation starts, customer action changes, or risk classification changes. |
| Monitoring | Update when health/SLO evidence confirms recovery or regression. |
| Resolved | Publish final customer-safe resolution summary with follow-up owner or known limitation. |
| Scheduled maintenance | Publish schedule, start, material change, completion, or cancellation updates. |

## Trigger Boundaries

| Trigger | Visibility | Publication gate |
|---|---|---|
| SLO burn | Internal | Customer-visible component impact confirmed by incident commander. |
| Synthetic monitor | Internal | Multi-signal confirmation or support/customer corroboration. |
| Support ticket | External candidate | Support lead confirms broader impact or named affected customer communication need. |
| Customer report | External candidate | Support lead redacts customer data and confirms component mapping. |
| Planned maintenance | External candidate | Release owner approves public window, impact, and rollback posture. |

## Customer Templates

| Template | Channel | Required evidence |
|---|---|---|
| Initial incident | Status page | Incident record impact summary. |
| Progress update | Status page or support ticket | Incident timeline and responder evidence. |
| Maintenance notice | Status page | Approved maintenance plan. |
| Resolution | Status page or support ticket | Resolved incident record. |

Required placeholders are `incident_id`, affected components, current status or
resolution summary, and next update condition or follow-up owner. Templates must
pass redaction before publication and must not include response-time guarantees
unless the support SLA/channel owner approves them in a separate issue.

## Unsupported Public Dimensions

| Dimension | Reason |
|---|---|
| Per-tenant private debug | Private tenant state belongs in support/admin tooling, not public status. |
| Raw provider internal topology | Provider internals are not a customer-facing component taxonomy. |
| Unverified root cause | Speculative root-cause text cannot be published as status evidence. |
| Contractual response SLA | Support SLA commitments require business/legal owner approval and live support policy. |
| Customer-specific data | Customer identifiers, ticket details, and private impact details require support-channel handling. |

## Dependency Links

- HOBO-496 support SLA and channel readiness owns support-SLA approval and
  customer-facing response commitments.
- [Plan 05](./reliability-observability-cost.md#plan-05) provides SLO, alert,
  burn-rate, health, and observability evidence inputs.
- [Launch Support Escalation](./launch-support-escalation.md) provides severity,
  support/debug prerequisites, redaction, and incident-template handoff context.
- [ADR-0045](./adr/02-identity-security.md#adr-0045) pins SLO-as-code,
  error-budget gating, and alerting as status evidence sources.
- [ADR-0058](./adr/03-data-plane.md#adr-0058) pins incident management, runbooks,
  and SRE escalation as the operational incident source.

## Follow-Up Gate

M1-M4 status-page implementation, live notification, subscriber management, and
support-SLA work may cite this record only after it is accepted. Until then, the
branch proves readiness shape and scope guards, not production status-page
capability.
