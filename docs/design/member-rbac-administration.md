---
type: Reference
title: "Member/RBAC Administration Scope And Acceptance"
description: "Source issue: HOBO-416."
tags: [hobo, design]
---

# Member/RBAC Administration Scope And Acceptance

Source issue: HOBO-416.

Executable proof lives in
[`src/draft/exp-proofs/ux/member-rbac-administration-scope`](../../src/draft/exp-proofs/ux/member-rbac-administration-scope/README.md).
Branch evidence is summarized in
[`proofs/hobo-416-member-rbac-administration`](./proofs/hobo-416-member-rbac-administration/README.md).

## M0 Acceptance Record

Member/RBAC Administration defines the launch-critical scope for workspace members, role
administration, project-bound authorization handoffs, approval obligations, and audit evidence. It
does not build the RBAC engine, policy engine, identity-provider sync, admin-console UI, or support
ticketing workflow.

## User And Business Goal

HoBo needs accepted M0 scope for member and role administration before downstream design/build work
can depend on workspace membership, project-scoped grants, SSO/SCIM bindings, no-self-escalation
guards, or support-visible access evidence. The accepted record must tell administrators and
security reviewers what is in the RBAC product boundary and what remains with adjacent initiatives.

## Primary Personas

| Persona | Need |
|---|---|
| Workspace admin | Understand member lifecycle states, invitation posture, and role-change responsibilities. |
| Security/policy admin | Review default roles, custom-role boundaries, separation-of-duties obligations, and no-self-escalation evidence before implementation. |
| Project owner | Know which project-scoped grants, ownership transfers, and lifecycle actions route through RBAC instead of project settings. |
| Support auditor | Inspect member, role, approval, and audit evidence without permission to mutate access. |

## Scope In

- Accepted member lifecycle states and administration responsibilities for v1 product surfaces.
- Role administration boundaries for built-in roles, custom-role handoff, project-scoped grants,
  and approval obligations.
- SSO/SCIM and manual invite assumptions as M1 contract inputs without integrating an identity
  provider.
- Service, UX, security, and support boundaries for member and RBAC administration.
- M1-ready evidence for membership state, role authority, SSO/SCIM binding, no-self-escalation,
  audit/support export, and scope boundary proof.

## Scope Out And Non-Goals

- Do not build the RBAC enforcement engine, policy engine, role-binding runtime, or default role
  action matrix in this issue.
- Do not integrate SSO/SCIM providers, synchronize identity groups, issue tokens, or implement
  identity-provider administration.
- Do not implement admin-console screens, invitation email delivery, onboarding flows, or support
  ticket workflows.
- Do not implement tenant isolation, tenant quota enforcement, billing, entitlements, provider
  access, or live customer-data migration.
- Do not create production organizations, live memberships, static credentials, or follow-up
  M1-M4 implementation issues before M0 acceptance.
- Do not replace [ADR-0074](./adr/02-identity-security.md#adr-0074), the policy-plane decision
  model, genesis admin, or break-glass policy.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Member/RBAC Administration defines member lifecycle and role-admin records; service persistence and policy evaluation remain later implementation work. |
| UX | Member/RBAC Administration defines information architecture and action classes; Admin Console owns screens and interaction flows. |
| Security | Member/RBAC Administration names least-privilege, no-self-escalation, SSO/SCIM, and audit expectations without implementing authorization. |
| Support | Member/RBAC Administration defines support-visible audit/export evidence; Support Workflow owns tickets, SLA, and escalation execution. |

## Authoritative Dependencies

- [Organization & Workspace Model](./organization-workspace-model.md) supplies the account,
  organization, workspace, project, tenant, and environment vocabulary that RBAC must not replace.
- [Settings & Project Lifecycle](./settings-project-lifecycle.md) defines project ownership and
  lifecycle actions that later role authority must govern.
- [Tenant Isolation & Quotas](./tenant-isolation-quotas.md) defines tenant and quota boundaries
  that member/admin permissions can expose but not enforce in this issue.
- [developer-experience.md#plan-07](./developer-experience.md#plan-07) defines dashboard and
  developer surfaces that consume project-scoped governance and role visibility.
- [security-networking.md#plan-12](./security-networking.md#plan-12) defines platform tenancy,
  zero-trust posture, and org governance over HoBo's control-plane surface.
- [ADR-0074](./adr/02-identity-security.md#adr-0074) pins RBAC, mandatory policy rules, deny
  ceilings, SSO/SCIM role binding, and audit obligations as the owning decision.
- [ADR-0077](./adr/02-identity-security.md#adr-0077) pins project and environment as rollup and
  authorization dimensions for role-scoped operations surfaces.

## Owning Initiative Dependencies

| Owner | Consumes from Member/RBAC Administration | Boundary |
|---|---|---|
| Member/RBAC Administration | Accepted member lifecycle, role-administration, approval, and audit evidence boundaries. | This issue defines scope and acceptance; it does not build RBAC services or policy evaluation. |
| Organization & Workspace Model | Account, organization, workspace, project, tenant, and environment nouns for member administration. | This issue does not redefine workspace ownership or create new scope nouns. |
| Settings & Project Lifecycle | Role authority requirements for project ownership, transfer, suspend, archive, restore, and delete decisions. | Settings and lifecycle state machines remain outside Member/RBAC M0. |
| Tenant Isolation & Quotas | Member/admin role boundaries for later tenant/quota visibility and override controls. | Tenant isolation, quota enforcement, and noisy-neighbor proof remain with Tenant Isolation & Quotas. |
| Security Verification | No-self-escalation, deny-by-default, and audit expectations as M1 security evidence inputs. | Security conformance, leak tests, and full policy-engine verification stay in Security Verification. |
| Support Workflow | Member, role, approval, and audit export fields for support-safe triage and handoff. | Support ticketing, SLA routing, and escalation execution stay in Support Workflow. |

## Evidence Required For M1

| Evidence | Owner | Proof mode | Proves |
|---|---|---|---|
| Membership state model | Member/RBAC Administration | Design record | Invited, active, suspended, removed, and externally-managed membership states are named with owner and audit expectations. |
| Role authority matrix | Security/policy admin | Reference fixture | Built-in roles, custom-role handoff, project-scoped grants, and approval obligations can be represented without enforcement code. |
| SSO/SCIM binding fixture | Workspace admin | Contract test | External group bindings and manual invite fallback are explicit inputs to later role-binding design. |
| No-self-escalation gate | Security Verification | Contract test | Role changes that would grant beyond the actor's authority require denial or an approval obligation. |
| Audit/support export | Support Workflow | Support handoff | Support can inspect member, role, approval, source, timestamp, and redaction state without mutating access. |
| Scope boundary register | Member/RBAC Administration | Policy fixture | RBAC enforcement, SSO/SCIM sync, admin UI, tenant/quota, billing, provider, and live-data work route to owning initiatives. |

## Follow-Up Gate

M1/M2/M3/M4 member, RBAC, SSO/SCIM, admin-console, support, or security implementation issues must
wait until this M0 scope record is accepted. This branch records the gate and its executable guard;
it does not create follow-up implementation issues.
