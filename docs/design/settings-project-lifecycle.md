---
type: Reference
title: "Settings And Project Lifecycle Scope And Acceptance"
description: "Source issue: HOBO-412."
tags: [hobo, design]
---

# Settings And Project Lifecycle Scope And Acceptance

Source issue: HOBO-412.

Executable proof lives in
[`src/draft/exp-proofs/ux/settings-project-lifecycle-scope`](../../src/draft/exp-proofs/ux/settings-project-lifecycle-scope/README.md).
Branch evidence is summarized in
[`proofs/hobo-412-settings-project-lifecycle`](./proofs/hobo-412-settings-project-lifecycle/README.md).

## M0 Acceptance Record

Settings & Project Lifecycle exists to define the launch-critical product control-plane record for
workspace settings, project ownership, lifecycle state, audit evidence, and support-visible handoff.
It is not the admin console, RBAC service, quota engine, environment lifecycle, or provider runtime.

## User And Business Goal

HoBo needs accepted M0 scope for workspace and project settings before downstream design/build work
can depend on project state. The accepted record must tell customers and internal operators which
settings classes are launch-critical, who owns them, which lifecycle states exist, what evidence M1
must prove, and which adjacent initiatives own enforcement or UI implementation.

## Primary Personas

| Persona | Need |
|---|---|
| Workspace admin | Understand which workspace and project settings are launch-critical and which require later governance proof. |
| Project owner | Create, archive, restore, and hand off projects without unclear ownership or hidden service assumptions. |
| Platform engineer | Know which project lifecycle states downstream deployment, environment, and quota work can rely on. |
| Support operator | Inspect settings, lifecycle state, owners, and audit evidence without taking admin-console implementation scope. |

## Scope In

- Canonical workspace and project settings classes with owner, customer visibility, launch
  criticality, and follow-up evidence requirement.
- Project lifecycle state model covering draft, active, suspended, archived, restore-pending, and
  deleted-terminal states.
- Lifecycle transition ownership for create, rename, transfer, suspend, archive, restore, and delete
  decisions.
- Audit and support-export requirements for settings changes and lifecycle transitions.
- M1-ready evidence checklist for schema, state-machine, audit event, RBAC-boundary, and support
  handoff proofs.

## Scope Out And Non-Goals

- Do not build admin-console workflows, screens, or interaction flows.
- Do not implement RBAC enforcement or member-management UI.
- Do not implement tenant quota metering, billing, or entitlement enforcement.
- Do not implement environment lifecycle beyond naming project boundary dependencies.
- Do not provision live provider resources, store provider credentials, or delete project resources.
- Do not create downstream M1-M4 execution issues before M0 scope is accepted.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Settings and project lifecycle are product control-plane records; this issue does not build the service runtime or persistence layer. |
| UX | UX scope is the accepted information architecture for settings and lifecycle actions, not admin-console screens or interaction flows. |
| Security | The record names ownership, audit, and RBAC dependency boundaries without implementing authorization or static credentials. |
| Support | Support can rely on lifecycle state, owner, and audit export requirements; ticketing workflow and SLA promises remain separate support work. |

## Settings Classes

| Class | Owner | Customer visible | Launch critical |
|---|---|---:|---:|
| Workspace profile | Workspace admin | Yes | Yes |
| Project metadata | Project owner | Yes | Yes |
| Lifecycle controls | Workspace admin | Yes | Yes |
| Support audit export | Support operator | No | Yes |

## Project Lifecycle States

| State | Meaning | M1 proof expectation |
|---|---|---|
| Draft | Project record exists but has not accepted launch/deploy readiness. | State-machine fixture covers creation and activation. |
| Active | Project can own settings, environments, deployments, and support exports. | Audit fixture records activation owner. |
| Suspended | Project is blocked from new launch/deploy actions while still inspectable. | RBAC-boundary fixture names who can suspend and resume. |
| Archived | Project is hidden from default active views but recoverable. | Support export keeps owner, state, and last-change evidence. |
| Restore-pending | Restore is requested and waiting for later environment/resource checks. | State-machine proof refuses immediate provider/resource claims. |
| Deleted-terminal | Project is no longer restorable from product UI. | Audit proof distinguishes product deletion from provider resource deletion. |

## Authoritative Dependencies

- [developer-experience.md#plan-07](./developer-experience.md#plan-07) defines dashboard and
  project-facing developer experience surfaces that consume settings/lifecycle state.
- [architecture.md#plan-10](./architecture.md#plan-10) defines the repository and control-plane
  shape that settings/project records must fit without adding runtime implementation.
- [security-networking.md#plan-50](./security-networking.md#plan-50) defines tenant isolation
  concerns consumed as boundaries, not implemented inside this M0 scope.
- [ADR-0077](./adr/02-identity-security.md#adr-0077) pins projects and environments as grouping
  dimensions for operations dashboards and status surfaces.
- [ADR-0074](./adr/02-identity-security.md#adr-0074) pins org governance and RBAC as mandatory
  dependencies while keeping enforcement out of this issue.

## Owning Initiative Dependencies

| Owner | Consumes from Settings & Project Lifecycle | Boundary |
|---|---|---|
| Settings & Project Lifecycle | Accepted settings classes, lifecycle states, transition owners, and M1 evidence checklist. | This issue defines scope; it does not build the settings service. |
| Member/RBAC Administration | Ownership and transition authority requirements for later member and role administration. | RBAC enforcement and member workflows remain in Member/RBAC Administration. |
| Tenant Isolation & Quotas | Project state and ownership as inputs for tenant and quota policy. | Quota accounting, limits, and isolation proof stay in Tenant Isolation & Quotas. |
| Environment Lifecycle | Project lifecycle state as a parent boundary for environment create/archive/restore behavior. | Environment state machines and cleanup behavior remain in Environment Lifecycle. |
| Deployment Dashboard & Topology Explorer | Project lifecycle and owner metadata alongside deployment/topology state. | Dashboard implementation and topology visualization remain outside Settings M0. |
| Support Workflow | Support-visible settings, owners, and audit exports for triage and handoff. | Support routing, SLA, and escalation flows remain in Support Workflow. |

## Evidence Required For M1

| Evidence | Owner | Proof mode | Proves |
|---|---|---|---|
| Settings schema | Workspace admin | Design record | Every settings class has owner, visibility, launch criticality, and support visibility. |
| Project lifecycle state machine | Project owner | Contract test | Project lifecycle states and allowed transition classes are deterministic. |
| Audit event fixture | Platform engineer | Audit fixture | Settings and lifecycle changes produce replayable owner/action/state evidence. |
| RBAC boundary matrix | Workspace admin | Reference fixture | RBAC dependency handoff is explicit without implementing authorization. |
| Support export contract | Support operator | Support handoff | Support receives state, owner, last-change, and redaction boundaries. |

## Follow-Up Gate

M1/M2/M3/M4 design or implementation issues must wait until this M0 scope record is accepted. This
branch records the gate and its executable guard; it does not create follow-up implementation
issues.
