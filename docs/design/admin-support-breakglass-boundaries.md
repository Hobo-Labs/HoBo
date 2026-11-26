---
type: Reference
title: "Admin And Support Break-Glass Access Boundaries"
description: "Source issue: HOBO-495."
tags: [hobo, design]
---

# Admin And Support Break-Glass Access Boundaries

Source issue: HOBO-495.

Executable proof lives in
[`src/draft/exp-proofs/ux/admin-support-breakglass-boundaries`](../../src/draft/exp-proofs/ux/admin-support-breakglass-boundaries/README.md).
Branch evidence is summarized in
[`proofs/hobo-495-admin-support-breakglass`](./proofs/hobo-495-admin-support-breakglass/README.md).

## M0 Acceptance Record

Admin and support break-glass access defines the emergency-access policy boundary for support,
security, incident response, and customer-admin handoffs before any live tooling exists. It records
who may request emergency access, who may approve it, what can be accessed, which audit facts are
mandatory, how long access can last, how customer notification is decided, and how access is
revoked.

It does not build break-glass tooling, Admin Console UI, ticketing, billing engines, incident
automation, provider access, static credentials, or live customer-data mutation.

## User And Business Goal

HoBo needs a deny-by-default emergency-access record before beta support or internal admin workflows
can rely on break-glass behavior. The accepted record must give support operators a customer-safe
request path, security reviewers a least-privilege approval rule, incident commanders a bounded
response path, and customer admins a notification posture without granting production access in this
M0 slice.

## Primary Personas

| Persona | Need |
|---|---|
| Support operator | Request narrowly scoped emergency access without self-approval or raw credential exposure. |
| Security approver | Approve or deny requests against least privilege, audit, TTL, and redaction obligations. |
| Incident commander | Coordinate customer-impacting emergency access with incident communication ownership. |
| Customer admin | Receive notification or approval handoff when customer-impacting access requires it. |

## Scope In

- Define break-glass roles and separation-of-duty obligations.
- Define access classes for tenant data, support debugging, billing adjustments, policy override
  review, and incident-response emergency access.
- Define approval path, audit event requirements, TTL, customer-notification posture, and
  revocation rule for each access class.
- Record unsupported emergency actions so default denial is explicit.
- Map handoffs to Admin Console, Member/RBAC, Support Workflow, Incident Communications, Audit
  Explorer, Billing/Entitlements, and Security Verification owners.
- List M1-ready evidence for policy fixtures, audit export, support handoff, and no-self-escalation
  checks.

## Scope Out And Non-Goals

- Do not build break-glass tooling, Admin Console screens, routes, controls, or session brokers in
  this issue.
- Do not create static emergency accounts, production admin roles, provider-console access, or raw
  provider credential access.
- Do not implement support ticket queues, billing adjustment engines, incident automation, legal
  notification workflows, or customer-success playbooks.
- Do not mutate live customer data or silently bypass Gatekeeper/policy decisions.
- Do not create downstream M1-M4 implementation issues before this M0 boundary is accepted.

## Policy Boundary

| Boundary | Rule |
|---|---|
| Default posture | Deny by default; every allowed emergency path must name an access class, owner, approver, TTL, audit facts, notification decision, and revocation rule. |
| Least privilege | Access must use the narrowest class that can resolve the approved incident or support need. |
| Approval | Requesters cannot approve their own sessions; approval must come from the owning security, incident, or customer-admin path. |
| Audit | `breakglass.requested`, `breakglass.approved`, `breakglass.started`, `breakglass.used`, and `breakglass.revoked` are mandatory event families for M1 proof. |
| TTL | The maximum M0 TTL is 60 minutes; narrower classes may set a lower ceiling. |
| Notification | Every session records a decision to notify, defer, or suppress notification with owner and redaction rationale. |
| Revocation | Access is revoked at TTL expiry, incident resolution, approval withdrawal, suspicious use, or customer/legal owner request. |

## Access Classes

| Access class | Owner | Max TTL | Approval path | Purpose |
|---|---|---:|---|---|
| Tenant data inspection | Security Verification | 30m | Security approver | Read redacted tenant-scoped evidence to confirm customer impact or data-safety state. |
| Support debug context | Support Workflow | 60m | Security approver | Read customer-safe logs, traces, project, entitlement, and environment context for support triage. |
| Billing adjustment review | Billing / Entitlements | 45m | Security approver + customer admin | Review billing, entitlement, or rate-limit facts without applying financial changes in this boundary. |
| Policy override review | Security Verification | 30m | Security approver | Review a policy-denied action without bypassing Gatekeeper or policy evidence. |
| Incident-response emergency | Incident Communications / Operators SRE | 60m | Incident commander + security approver | Coordinate emergency response evidence when impact is customer-visible or uncertain. |

## Unsupported Emergency Actions

- Static break-glass accounts.
- Self-approved sessions.
- Raw provider credential access.
- Silent policy or Gatekeeper bypass.
- Unbounded live customer-data mutation.
- Indefinite sessions.
- Break-glass tooling implementation in this M0 issue.

## Authoritative Dependencies

- [admin-console.md](./admin-console.md) defines future visibility and action-intent surfaces.
- [member-rbac-administration.md](./member-rbac-administration.md) defines role, approval, and
  no-self-escalation obligations.
- [support-sla-channels.md](./support-sla-channels.md) defines support handoff and unsupported
  request routing.
- [launch-support-escalation.md](./launch-support-escalation.md) defines incident ownership,
  communications, and redaction prerequisites.
- [audit-explorer.md](./audit-explorer.md) defines audit facts and redacted export evidence.
- [security-verification.md](./security-verification.md) defines launch-blocking security
  verification and customer communication boundaries.

## Evidence Required For M1

| Evidence | Owner | Proof mode | Proves |
|---|---|---|---|
| Break-glass policy fixture | Security Verification | Policy fixture | Roles, access classes, TTL, approval, notification, and revocation are machine-checkable. |
| No-self-escalation gate | Member/RBAC Administration | Contract test | Requesters cannot approve their own emergency sessions. |
| Audit event export | Audit Explorer | Audit fixture | Required `breakglass.*` facts are present before a session can be accepted. |
| Support handoff fixture | Support Workflow | Support handoff | Support can route tenant data, debug, billing, policy, and incident requests to owners. |
| Unsupported action matrix | Security Verification | Negative test | Static accounts, raw credentials, silent bypass, live-data mutation, indefinite sessions, and tooling implementation are refused. |

## Follow-Up Gate

M1/M2/M3/M4 break-glass tooling, Admin Console controls, support automation, RBAC enforcement,
customer notification workflow, audit export, or incident-response implementation issues must wait
until this M0 boundary record is accepted. This branch records the policy shape and executable guard;
it does not create live access capability.
