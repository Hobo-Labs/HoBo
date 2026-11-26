---
type: Reference
title: "Admin Console Scope And Acceptance"
description: "Source issue: HOBO-425."
tags: [hobo, design]
---

# Admin Console Scope And Acceptance

Source issue: HOBO-425.

Executable proof lives in
[`src/draft/exp-proofs/ux/admin-console-scope`](../../src/draft/exp-proofs/ux/admin-console-scope/README.md).
Branch evidence is summarized in
[`proofs/hobo-425-admin-console`](./proofs/hobo-425-admin-console/README.md).

## M0 Acceptance Record

Admin Console defines the launch-critical product control surface for workspace, project, tenant,
environment, entitlement, support, and security visibility. It records navigation, read-model,
action-intent, audit, redaction, and boundary evidence. It does not build screens, service runtime,
RBAC enforcement, support ticketing, provider access, or live customer-data mutation.

## User And Business Goal

HoBo needs accepted M0 scope for Admin Console before downstream design/build work can depend on
administrative visibility or action semantics. The accepted record must tell administrators,
project owners, support operators, and security reviewers which information the console exposes,
which action intents it may express, which adjacent initiatives own enforcement, and what evidence
M1 must prove.

## Primary Personas

| Persona | Need |
|---|---|
| Workspace admin | Understand organization, workspace, project, tenant, entitlement, and environment state without hidden authority assumptions. |
| Project owner | See project health, ownership, lifecycle state, and pending admin actions without taking provider or runtime implementation scope. |
| Support operator | Inspect customer-safe context, audit summaries, and escalation owners without mutating customer data. |
| Security/policy admin | Review least-privilege action classes, break-glass visibility, redaction rules, and no-secret exposure before implementation. |

## Scope In

- Launch-critical Admin Console information architecture for organization, workspace, project,
  tenant, environment, entitlement, support, and security visibility.
- Read-model classes and ownership for status cards, audit summaries, support context, lifecycle
  state, and broker/environment proposal visibility.
- Action-intent categories, approval handoffs, and denial states, with execution routed to owning
  initiatives.
- Service, UX, security, and support boundaries for admin-console product scope.
- M1-ready evidence for navigation, read-model contracts, action-intent matrix, audit/redaction
  export, break-glass visibility, and scope boundary proof.

## Scope Out And Non-Goals

- Do not build React screens, routes, components, client state, or interaction flows in this issue.
- Do not implement RBAC enforcement, policy evaluation, member lifecycle changes, SSO/SCIM sync, or
  role binding.
- Do not implement tenant isolation, quota enforcement, billing, entitlements, rate limits, support
  ticket queues, or incident/status-page publishing.
- Do not read or store provider credentials, mutate live customer data, provision resources, or
  execute admin actions.
- Do not create production admin roles, live break-glass sessions, static credentials, or follow-up
  M1-M4 implementation issues before M0 acceptance.
- Do not replace the existing Developer Experience dashboard, Settings & Project Lifecycle,
  Member/RBAC, break-glass policy, support workflow, or Meta-cloud Broker records.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Admin Console defines read-model and action-intent contract boundaries; service persistence, projector runtime, and mutation execution remain later implementation work. |
| UX | Admin Console defines navigation and information architecture; it does not build screens, component behavior, or interaction flows in this issue. |
| Security | Admin Console names least-privilege, redaction, break-glass visibility, and no-secret exposure requirements without implementing authorization. |
| Support | Admin Console defines support-visible context and handoff fields; Support Workflow owns tickets, SLA routing, and escalation execution. |

## Read-Model Classes

| Class | Owner | Customer visible | Launch critical |
|---|---|---:|---:|
| Workspace overview | Admin Console | Yes | Yes |
| Project lifecycle summary | Settings & Project Lifecycle | Yes | Yes |
| Member role summary | Member/RBAC Administration | Yes | Yes |
| Tenant quota summary | Tenant Isolation & Quotas | Yes | Yes |
| Support debug context | Support Workflow | No | Yes |
| Security audit redaction | Security Verification | No | Yes |

## Action-Intent Categories

| Intent | M1 proof expectation |
|---|---|
| Inspect | Read-only fixture proves current state can be shown without mutation authority. |
| Request change | Reference fixture records requested action and owning initiative without executing it. |
| Approve or deny | Policy fixture records decision state and required handoff without implementing RBAC. |
| Escalate to support | Support handoff fixture records owner and redaction state. |
| Export audit summary | Audit fixture records actor, action, timestamp, target, and redaction fields. |
| View break-glass state | Policy fixture proves visibility without granting live access or credentials. |

## Authoritative Dependencies

- [developer-experience.md#plan-07](./developer-experience.md#plan-07) defines the dashboard and
  operations experience where Admin Console surfaces are later exposed.
- [Organization & Workspace Model](./organization-workspace-model.md) supplies account,
  organization, workspace, project, tenant, and environment nouns the console must display without
  redefining them.
- [Settings & Project Lifecycle](./settings-project-lifecycle.md) defines project state, settings
  ownership, and lifecycle transitions consumed as read-model inputs.
- [Member/RBAC Administration](./member-rbac-administration.md) defines role, membership, approval,
  and audit boundaries for later admin actions.
- [Tenant Isolation & Quotas](./tenant-isolation-quotas.md) defines tenant and quota dimensions the
  console may expose while leaving enforcement out of scope.
- [Support SLA Channels](./support-sla-channels.md) defines support context, SLA, and escalation
  handoffs consumed by support-visible console views.
- [Admin Support Break-Glass Boundaries](./admin-support-breakglass-boundaries.md) defines emergency
  access approval, audit, TTL, customer-notification, and revocation boundaries for later console
  visibility without granting live access.
- [security-networking.md#plan-50](./security-networking.md#plan-50) defines tenant isolation and
  security/networking boundaries for admin visibility.
- [ADR-0074](./adr/02-identity-security.md#adr-0074) pins org governance, RBAC, mandatory policy
  rules, deny ceilings, and audit obligations.
- [ADR-0077](./adr/02-identity-security.md#adr-0077) pins projects and environments as grouping
  dimensions for operations dashboards and status surfaces.
- [ADR-0080](./adr/02-identity-security.md#adr-0080) pins tenant isolation by construction and
  cross-tenant leak conformance as hard security boundaries.

## Owning Initiative Dependencies

| Owner | Consumes from Admin Console | Boundary |
|---|---|---|
| Admin Console | Accepted navigation, read-model classes, action-intent categories, and evidence gates. | This issue defines scope and acceptance; it does not build UI or service runtime. |
| Settings & Project Lifecycle | Project state, owners, lifecycle transitions, and settings classes for console read models. | Lifecycle state machines and settings mutation remain outside Admin Console M0. |
| Member/RBAC Administration | Role authority, membership, approval, no-self-escalation, and audit evidence for later admin actions. | RBAC enforcement, SSO/SCIM, member workflows, and policy evaluation stay with Member/RBAC. |
| Tenant Isolation & Quotas | Tenant, quota, limit, and noisy-neighbor visibility for console summaries. | Tenant isolation, quota enforcement, and billing/entitlement behavior remain outside Admin Console. |
| Support Workflow | Console-safe context, redaction state, owners, and escalation fields for support triage. | Ticketing, SLA routing, and support automation stay in Support Workflow. |
| Security Verification | Redaction, no-secret exposure, break-glass visibility, and cross-tenant guardrails as M1 evidence inputs. | Security conformance suites, credential checks, and leak tests stay in Security Verification. |
| Admin Support Break-Glass Boundaries | Emergency access classes, approval path, audit events, TTL, customer-notification posture, and revocation state for later visibility. | Break-glass tooling, live sessions, static credentials, and support/admin access brokers stay outside Admin Console M0. |
| Meta-cloud Broker | Broker environment proposal and approval visibility requirements for later admin surfaces. | Broker resolution, Yard planner behavior, provider mapping, and receipt mutation stay outside Admin Console. |

## Evidence Required For M1

| Evidence | Owner | Proof mode | Proves |
|---|---|---|---|
| Navigation information architecture | Admin Console | Design record | Admin Console navigation names workspace, project, tenant, environment, support, and security surfaces without UI implementation. |
| Read-model contract | Admin Console | Contract test | Each console read-model class has owner, visibility, launch criticality, and redaction state. |
| Action-intent matrix | Member/RBAC Administration | Reference fixture | Inspect, request, approve/deny, support escalation, audit export, and break-glass visibility are represented without executing mutations. |
| Audit/redaction export | Security Verification | Audit fixture | Support and security summaries expose owners, timestamps, actions, and redaction state without secrets or raw customer data. |
| Break-glass visibility fixture | Security/policy admin | Policy fixture | Break-glass state can be visible and auditable without granting live access or credentials. |
| Scope boundary register | Admin Console | Support handoff | UI implementation, RBAC, quota, billing, support workflow, provider credential, live data, and broker runtime work route to owning initiatives. |

## Follow-Up Gate

M1/M2/M3/M4 admin-console design, UI, service, support, RBAC, quota, broker, or security
implementation issues must wait until this M0 scope record is accepted. This branch records the
gate and its executable guard; it does not create follow-up implementation issues.
