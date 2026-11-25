---
type: Reference
title: "Organization & Workspace Model Scope And Acceptance"
description: "Source issue: HOBO-413."
tags: [hobo, design]
---

# Organization & Workspace Model Scope And Acceptance

Source issue: HOBO-413.

Executable proof lives in
[`src/draft/exp-proofs/api/organization-workspace-model-contract`](../../src/draft/exp-proofs/api/organization-workspace-model-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-413-organization-workspace-model`](./proofs/hobo-413-organization-workspace-model/README.md).

## M0 Acceptance Record

HoBo needs a compact product model for organizations and workspaces before downstream UX, RBAC,
tenant isolation, project lifecycle, onboarding, and support work fan out. This record defines the
nouns, owner handoffs, and evidence gates. It does not implement workspace runtime behavior.

## User And Business Goal

The Organization & Workspace Model gives app developers, workspace admins, platform engineers, and
support operators a shared answer to what an organization owns, what a workspace contains, where
projects and environments live, and which adjacent team owns enforcement or customer-facing flows.

## Primary Personas

| Persona | Need |
|---|---|
| Workspace admin | Understand organization ownership, workspace contents, and approval responsibilities. |
| Platform engineer | Map workspaces to Projects, Environments, Camps, Yards, and tenant boundaries without inventing runtime scope. |
| App developer | Know where first project creation, settings, default environment, and deploy ownership appear in onboarding. |
| Support/operator | Route org/workspace incidents, audit exports, ownership disputes, and unsupported account shapes. |

## Scope In

- Define canonical account, organization, workspace, project, tenant, and environment vocabulary for v1 product surfaces.
- Define ownership, lifecycle, and boundary rules consumed by adjacent M0 projects.
- Define service, UX, security, and support boundaries for workspace creation, project grouping, member visibility, and audit handoff.
- Define M1-ready evidence for domain model fixtures, RBAC handoff, tenant/quota handoff, project lifecycle handoff, and support export handoff.
- Define follow-up gate rules so M1/M2/M3/M4 implementation issues wait for accepted M0 scope.

## Scope Out And Non-Goals

- Do not build workspace creation, invite, member management, RBAC, quota, or tenant isolation runtime behavior in this issue.
- Do not create customer data, production organizations, live workspaces, or provider resources.
- Do not define billing account, entitlement, payment, tax, or commercial packaging behavior.
- Do not implement project settings, environment lifecycle, onboarding telemetry, or dashboard UI.
- Do not resolve launch support, legal/privacy, or customer-success process ownership beyond routing boundaries.
- Do not replace the existing Bindle/Camp/Yard/Junction scope model.
- Do not create a new organization-scoped runtime primitive.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Organization & Workspace Model defines product ownership and grouping semantics; service implementation stays with Settings & Project Lifecycle and adjacent capability projects. |
| UX | Organization & Workspace Model defines nouns and first-run surface responsibilities; Workspace & Onboarding UX owns screen flows, activation telemetry, and UI copy. |
| Security | Organization & Workspace Model defines required security handoffs; Member/RBAC Administration and Tenant Isolation & Quotas own enforcement, policy, and isolation implementation. |
| Support | Organization & Workspace Model defines support-visible ownership and audit/export expectations; launch support owns response targets and escalation execution. |

## Authoritative Dependencies

- [architecture.md#plan-10](./architecture.md#plan-10) defines project/package architecture and the existing scope vocabulary that productized workspaces must not replace.
- [developer-experience.md#plan-07](./developer-experience.md#plan-07) defines dashboard, status, CLI, inspect, and project-facing developer surfaces that consume workspace/project nouns.
- [security-networking.md#plan-50](./security-networking.md#plan-50) defines app-tenant and tenant-routing boundaries that the workspace model routes to, not implements.
- [ADR-0074](./adr/02-identity-security.md#adr-0074) pins org governance, RBAC, mandatory rules, and control-plane action taxonomy as security-owned scope.
- [ADR-0079](./adr/02-identity-security.md#adr-0079) pins app multi-tenancy as a separate model consumed by product workspaces.
- [ADR-0080](./adr/02-identity-security.md#adr-0080) pins tenant isolation conformance and prevents unsupported workspace isolation claims.

## Owning Initiative Dependencies

| Owner | Consumes from Organization & Workspace Model | Boundary |
|---|---|---|
| Organization & Workspace Model | Accepted vocabulary and owner map become the M1 input for org/workspace domain fixtures. | This issue records scope and acceptance only; it does not build workspace runtime behavior. |
| Tenant Isolation & Quotas | Workspace and tenant boundaries identify where isolation and quota claims must be enforced. | Quota accounting, tenant isolation, and cross-tenant leak prevention remain outside this M0 scope. |
| Member/RBAC Administration | Organization roles, workspace membership visibility, and approval nouns feed RBAC design. | Member invitations, SSO/SCIM, role bindings, and policy enforcement stay in RBAC scope. |
| Settings & Project Lifecycle | Project and environment ownership rules define which settings/lifecycle surfaces belong under a workspace. | Project creation, archive/restore, environment lifecycle, and settings UI are not built here. |
| Workspace & Onboarding UX | First workspace/project activation can use accepted nouns and unsupported-state wording. | Onboarding flows, activation metrics, and dashboard IA remain in Workspace & Onboarding UX. |
| V1 Release Program & Cutline | Unsupported organization shapes and missing evidence route into launch limitation or blocker taxonomy. | Go/no-go decisions, blocker exceptions, and launch notes stay with the release cutline. |

## Evidence Required For M1

| Evidence | Owner | Proof mode | Proves |
|---|---|---|---|
| Domain model | Organization & Workspace Model | Design record | Canonical nouns, allowed relationships, ownership rules, and unsupported shapes are stable enough for M1 proof. |
| Membership/RBAC handshake | Member/RBAC Administration | Contract test | Workspace roles, approvals, and membership visibility are consumed by RBAC without hidden enforcement here. |
| Tenant/quota handshake | Tenant Isolation & Quotas | Contract test | Workspace and tenant boundaries route isolation and quota claims to the owning project. |
| Project lifecycle handshake | Settings & Project Lifecycle | Reference fixture | Workspace-scoped project/environment lifecycle states can be represented without adding runtime primitives. |
| Support audit export | V1 Launch Support Desk & Escalation | Support handoff | Support can identify workspace owner, project, environment, tenant boundary, and unsupported-state reason. |

## Follow-Up Gate

M1/M2/M3/M4 domain, RBAC, tenant/quota, settings, onboarding, or support implementation issues must
wait until this M0 scope record is accepted. This branch records the gate and its executable guard;
it does not create follow-up implementation issues.
