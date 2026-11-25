---
type: Reference
title: "Launch Support Escalation Matrix"
description: "Source issue: HOBO-408."
tags: [hobo, design]
---

# Launch Support Escalation Matrix

Source issue: HOBO-408.

Executable proof lives in
[`src/draft/exp-proofs/cx/launch-support-escalation-matrix`](../../src/draft/exp-proofs/cx/launch-support-escalation-matrix/README.md).
Branch evidence is summarized in
[`proofs/hobo-408-launch-support-escalation`](./proofs/hobo-408-launch-support-escalation/index.md).

## M0 Acceptance Record

Launch support needs a concrete escalation matrix before beta and GA readiness work can claim that
customer-impacting incidents have an owner, a communication path, and a handoff rule. This record
defines severity levels, support/debug prerequisites, draft customer communication templates, and
gap routing. It does not implement support tooling or promise public response SLAs.

## Role Coverage

| Role | Responsibility |
|---|---|
| Support lead | Owns intake quality, customer context, and support queue handoff. |
| Incident commander | Coordinates severity, owner routing, and incident record hygiene. |
| First responder | Starts triage, gathers evidence, and confirms first escalation path. |
| Customer communications owner | Publishes approved customer updates after redaction and evidence checks. |
| Release owner | Approves launch readiness gaps and any response commitment language. |

## Severity Matrix

| Severity | First responder | Escalation owner | Expected response | Customer communication | Handoff criteria |
|---|---|---|---|---|---|
| SEV0: customer-impacting outage or data safety risk | On-call first responder | Incident commander plus operators/SRE owner | Begin live triage, open an incident record, and escalate to the incident commander immediately. | Status page plus named customer channel when affected accounts are known. | Impact is confirmed or unknown after initial triage; data safety, auth, networking, or rollback decision is needed; customer update needs approval. |
| SEV1: major degraded production path | Support lead or on-call first responder | Operators/SRE owner | Open an incident record, attach evidence, and route to the owning operational lane. | Status page when customer-visible, otherwise support ticket update. | Workaround is unavailable or unverified; rollback, provider escalation, or runbook action is required. |
| SEV2: limited feature regression or support-facing defect | Support lead | Admin console or product release owner | Collect reproduction evidence, classify the affected product lane, and file a follow-up issue. | Support ticket update. | Support cannot resolve from documented evidence; defect requires admin tooling, product decision, or customer-specific mitigation. |
| SEV3: question, documentation gap, or launch readiness follow-up | Support queue owner | Support lead | Answer from approved launch material or route the gap to the owning readiness project. | Support ticket or launch FAQ update. | No approved answer exists; question exposes a missing beta or GA readiness criterion. |

This severity model aligns with incident ownership and on-call obligations from
[Plan 40](./operators-sre.md#plan-40), status-page publication from
[Plan 49](./developer-experience.md#plan-49), alert/observability evidence from
[Plan 05](./reliability-observability-cost.md#plan-05), and the incident aggregate from
[ADR-0058](./adr/03-data-plane.md#adr-0058).

## Support And Debug Prerequisites

| Area | Owner lane | Prerequisite |
|---|---|---|
| Observability access | Reliability/observability/cost | Support can read scoped metrics, logs, traces, and SLO burn context for affected projects. |
| Incident timeline | Operators/SRE | Incident records preserve opened, classified, escalated, mitigated, and resolved events. |
| Tenant context | Admin console | Support can identify affected account, project, environment, plan, and entitlement context without secret exposure. |
| Status-page redaction | Support | Customer updates pass redaction review before internal incident details become public status text. |
| Runbook notification | Operators/SRE | Runbook and `hobo:notify` handoffs expose owner, acknowledgement, escalation, and deadline state. |
| Release and feature context | Support | Support can map a ticket to launch phase, feature flag, release, and known limitation evidence. |

## Incident Communication Templates

These are draft templates. Before public use, each message must pass redaction review and be backed
by the incident record or linked responder evidence.

| Template | Audience | Channel | Required evidence |
|---|---|---|---|
| Initial acknowledgement | Affected customers | Support ticket or status page | Incident record impact summary. |
| Investigation update | Affected customers and launch stakeholders | Support ticket, status page, or launch-room update | Incident timeline and responder notes. |
| Mitigation update | Affected customers and launch stakeholders | Support ticket or status page | Mitigation event and runbook output. |
| Resolution follow-up | Affected customers and internal launch review | Support ticket, status page resolution, or postmortem note | Resolved incident record and follow-up issue links. |

Required placeholders are `incident_id`, impact or affected capability, current status, next update
condition, and follow-up owner when known. Templates must not include response-time guarantees unless
the release owner explicitly approves customer-facing SLA language.

## Gap Routing

| Gap | Owner lane | Follow-up project |
|---|---|---|
| Missing support queue procedure, FAQ, or customer response owner | Support | V1 Launch Support Desk & Escalation |
| Missing customer, tenant, project, entitlement, or launch phase visibility | Admin console | V1 Admin Console & Operator UX |
| Missing incident command, runbook, on-call, `hobo:notify`, or escalation evidence | Operators/SRE | Operator Agents, SRE & Incident Response |
| Missing metrics, logs, traces, SLO burn, alert routing, or cost context | Reliability/observability/cost | Reliability, Observability & Cost Controls |

## Scope Out And Non-Goals

- Do not implement support tooling, ticket automation, admin console surfaces, status-page publish
  flows, runbook execution, or notification dispatch in HOBO-408.
- Do not promise response SLAs, time-to-response commitments, or public support tiers without owner
  approval.
- Do not replace Plan 40 incident management, Plan 49 status-page contracts, or Plan 05
  observability/alert routing.
- Do not create M1-M4 implementation tasks before the M0 escalation record is accepted.

## Follow-Up Gate

Downstream support, admin console, operators/SRE, and reliability implementation issues may cite this
record only after it is accepted. Until then, the branch proves readiness shape and scope guards, not
production support capability.

## M1 Dogfood/Alpha Evidence

Source issue: HOBO-460.

Executable proof lives in
[`src/draft/exp-proofs/cx/launch-support-dogfood-alpha-evidence`](../../src/draft/exp-proofs/cx/launch-support-dogfood-alpha-evidence/README.md).
Branch evidence is summarized in
[`proofs/hobo-460-launch-support-dogfood-alpha`](./proofs/hobo-460-launch-support-dogfood-alpha/README.md).

The M1 gate records six support evidence items:

- accepted support escalation model from this M0 record;
- SEV0/SEV1 handoff drill to incident command and Operators/SRE;
- alpha known-limitation FAQ evidence gap, tracked as a non-blocking launch-note follow-up;
- customer-safe redaction sample from Incident Communications;
- scoped debug access fixture from Reliability/Observability/Cost;
- support finding export into the launch blocker taxonomy and release cutline.

The accepted M1 state has no launch blockers. It carries one non-blocking follow-up for the alpha
known-limitation FAQ and keeps support tooling, ticket automation, status-page publication, live
customer support operations, and customer-facing SLA commitments out of this branch.

## M2 Private Beta Evidence

Source issue: HOBO-467.

Executable proof lives in
[`src/draft/exp-proofs/cx/launch-support-private-beta-evidence-contract`](../../src/draft/exp-proofs/cx/launch-support-private-beta-evidence-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-467-launch-support-private-beta`](./proofs/hobo-467-launch-support-private-beta/README.md).

The M2 gate records six support evidence items:

- private beta support escalation baseline from this support record;
- support workflow intake, triage, owner route, and customer-safe update states;
- support SLA/channel language that separates private beta promises from GA commitments;
- incident communication redaction gates for customer-visible updates;
- security-sensitive escalation routing through Security Verification;
- support readiness export into the V1 Release Program & Cutline.

The accepted M2 state carries private beta limitations and accepted risks without converting them
into public SLA promises. M3/M4 follow-ups are limited to missing release-candidate support drill
evidence and GA support handoff evidence. Support runtime services, ticket queues, status-page
publication, live support operations, customer-data access, and commercial terms remain out of this
branch.

## M3 Release Candidate Evidence

Source issue: HOBO-474.

Executable proof lives in
[`src/draft/exp-proofs/cx/launch-support-release-candidate-evidence-contract`](../../src/draft/exp-proofs/cx/launch-support-release-candidate-evidence-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-474-launch-support-release-candidate`](./proofs/hobo-474-launch-support-release-candidate/index.md).

The M3 gate records seven support evidence items:

- private beta support baseline from HOBO-467;
- release-candidate support drill evidence owned by Launch Support;
- incident-command handoff rehearsal owned by Operators/SRE;
- customer-update redaction rehearsal owned by Public Status Page & Incident Communication;
- security-sensitive support escalation route owned by Security Verification;
- release-cutline support signoff owned by V1 Release Program & Cutline;
- missing GA support handoff evidence owned by HOBO-481.

The accepted M3 state keeps GA support commitments blocked until HOBO-481 records final handoff
evidence. It carries manual release-candidate support drill and redaction rehearsal risks without
creating support tooling, ticket automation, status-page publication, live customer operations,
customer-data access, commercial support terms, customer-facing SLA guarantees, or GA support
readiness claims.

## M4 GA Handoff Evidence

Source issue: HOBO-481.

Executable proof lives in
[`src/draft/exp-proofs/cx/launch-support-ga-handoff-evidence-contract`](../../src/draft/exp-proofs/cx/launch-support-ga-handoff-evidence-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-481-launch-support-ga-handoff`](./proofs/hobo-481-launch-support-ga-handoff/index.md).

The M4 gate records eight support evidence items:

- M0 launch support escalation baseline from this support record;
- private beta support baseline from HOBO-467;
- release-candidate support drill evidence from HOBO-474;
- GA support owner signoff owned by Launch Support;
- GA support SLA/channel boundary owned by Support SLA Channels;
- incident communication redaction handoff owned by Public Status Page & Incident Communication;
- security-sensitive support data route owned by Security Verification;
- release-cutline GA support signoff owned by V1 Release Program & Cutline.

The accepted M4 state clears the HOBO-474 GA support handoff gap, reduces launch risk for the
parent HoBo v1 Release Readiness initiative, and leaves no missing-evidence follow-up issue in this
gate. It preserves accepted risks for manual support owner signoff, customer-data access remaining
behind security approval, and public status-page publication staying with the status-page owner.
Support runtime services, ticket queues, status-page publication, live customer-data access,
customer-facing SLA approval, paid support terms, and unsupported GA support claims remain out of
scope.

## Hosted Broker Support/Debug Handoff

HOBO-530 adds a broker-specific support/debug input for GA handoff review. Support can route
Resolution Receipt and Resolution Rejection evidence when the bundle names manifest digest,
Broker Environment snapshot, catalog snapshot, decision/reason code, and redaction status.

This handoff does not grant support access to customer payloads, provider credentials, broker
runtime state, or admin mutation paths. If a broker question requires those surfaces, Support routes
the gap to the owning implementation project instead of promoting a GA support claim.
