---
type: Reference
title: "Environment Lifecycle Scope And Acceptance"
description: "Source issue: HOBO-414."
tags: [hobo, design]
---

# Environment Lifecycle Scope And Acceptance

Source issue: HOBO-414.

Executable proof lives in
[`src/draft/exp-proofs/dx/environment-lifecycle-scope`](../../src/draft/exp-proofs/dx/environment-lifecycle-scope/README.md).
Branch evidence is summarized in
[`proofs/hobo-414-environment-lifecycle`](./proofs/hobo-414-environment-lifecycle/README.md).

## M0 Acceptance Record

Environment Lifecycle defines the launch-critical product control-plane record for environment
classes, lifecycle states, transition ownership, evidence fields, support handoff, and follow-up
proof gates. It gives downstream design/build work a stable boundary for local-dev, preview,
development, staging, production, and ephemeral environments.

It does not build an environment service runtime, provider provisioning, DNS, gateway routing,
deployment execution, admin-console UI, RBAC enforcement, tenant quota/billing behavior,
backup/restore runtime, cleanup sweepers, or support ticketing.

## HoBo.CD: environments as delivery targets

HoBo.CD ([ADR-0180](./adr/01-architecture-core.md#adr-0180); [continuous-delivery.md](./continuous-delivery.md)) is the delivery engine for the lifecycle below:

- **Promotion between environments** is a pipeline node per environment: Freight
  reaches `prod` only after qualifying in the upstream node (a PASS
  verification) plus soak, or through an audited, expiring approval.
- **Preview environments** are pipeline nodes with `preview_ttl_ms`: a preview
  Camp is cloned (`env.Cloned`) and expires (`env.Expired`) through the same
  gate, Matching and reconciler as any Camp.
- **Freezes** are change windows (ALLOW/FREEZE with a recurrence and timezone);
  a closed window holds promotion, and rollback is allowed by default.
- **Management mode.** A Camp is `MANAGED` (the default) or `OBSERVE_ONLY`,
  which reports and evaluates posture but never applies; brownfield
  environments start observe-only.
- **Leaving a fleet.** A Camp that leaves a placed node departs with the node's
  departure action; the default `ORPHAN_DATA` removes compute and keeps data
  resources, and records what it kept. `hobo down` keeps its existing teardown
  semantics.

## User And Business Goal

HoBo needs accepted M0 scope for environment lifecycle before downstream work can depend on
environment state. The accepted record must tell workspace admins, project owners, platform
engineers, and support operators which environments exist, which states are valid, who owns each
transition, what evidence M1 must prove, and which adjacent initiatives own enforcement or runtime
implementation.

## Primary Personas

| Persona | Need |
|---|---|
| Workspace admin | Understand environment ownership, state, and approval dependencies before granting launch authority. |
| Project owner | Create, suspend, archive, restore, and delete environments without unclear provider or quota assumptions. |
| Platform engineer | Consume deterministic environment state in deploy, preview, topology, rollback, and support records. |
| Support operator | Inspect customer-safe state, owner, limitation, evidence gaps, and escalation paths. |

## Scope In

- Launch environment classes for local-dev, preview, development, staging, production, and
  ephemeral environments.
- Lifecycle states: requested, provisioning-blocked, active, suspended, archived, restore-pending,
  deleting, and deleted-terminal.
- Transition ownership for create, activate, suspend, archive, restore, delete, fork, and promote
  decisions.
- Required evidence: parent project, environment owner, tenant boundary, policy class, last
  deployment signal, restore point, cleanup handoff, and support export.
- Service, UX, security, and support boundaries for downstream M1 design and contract proof.
- M1 evidence requirements and the follow-up issue gate.

## Scope Out And Non-Goals

- Do not build an environment service runtime, database, API, queue, or persistence layer.
- Do not provision live provider resources, DNS, gateway routing, deployment execution, or
  infrastructure mutation.
- Do not build admin-console screens, approval flows, client state, or interaction implementation.
- Do not implement RBAC enforcement, member role binding, policy engine, static credentials, or
  authorization runtime.
- Do not implement tenant quota, billing, entitlement enforcement, usage metering, or cost routing.
- Do not implement backup/restore runtime, live garbage collection, resource cleanup sweepers, drift
  detection, or teardown execution.
- Do not create downstream M1-M4 implementation issues before this M0 scope is accepted.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Environment Lifecycle owns classes, states, transition owners, and evidence fields; runtime and persistence stay later. |
| UX | This record defines information architecture and labels only; screens, routes, and interaction flows stay later. |
| Security | RBAC, policy, tenant, quota, and credential enforcement remain with their owning initiatives. |
| Support | Support can rely on state, owner, limitation, and escalation evidence; ticketing and SLA automation stay separate. |

## Environment Classes

| Class | Meaning |
|---|---|
| Local-dev | Developer-owned local or simulated environment with no hosted availability claim. |
| Preview | Short-lived review environment tied to a branch, pull request, or fork lane. |
| Development | Shared non-production environment for active project iteration. |
| Staging | Release-candidate environment for production-like validation and support rehearsal. |
| Production | Customer-impacting environment that requires explicit ownership, policy, and support evidence. |
| Ephemeral | TTL-bound environment that carries expiry, cleanup, and support handoff evidence. |

## Lifecycle States

| State | Meaning | M1 proof expectation |
|---|---|---|
| Requested | Environment intent exists but provisioning, tenancy, or policy proof is not accepted. | Schema fixture records requested state and required owner fields. |
| Provisioning-blocked | Environment cannot become active until owner, tenant, provider, policy, or support blockers resolve. | Contract test rejects active claims while blockers remain. |
| Active | Environment can be referenced by deployments, dashboards, support exports, and topology records. | State-machine fixture records activation owner and timestamp. |
| Suspended | Environment remains inspectable while new deploy or mutation actions are blocked. | Transition matrix names who can suspend and resume. |
| Archived | Environment is hidden from default active views but retains restore, support, and cleanup evidence. | Support export preserves owner, reason, and last-change evidence. |
| Restore-pending | Restore is requested and waiting for backup, tenant, policy, and resource checks. | Restore fixture refuses backup/restore runtime claims. |
| Deleting | Deletion intent is recorded but cleanup/teardown evidence is still outstanding. | Cleanup handoff fixture records owner and unresolved work. |
| Deleted-terminal | Product lifecycle has ended without claiming provider resources were removed. | Audit proof distinguishes product deletion from provider cleanup. |

## Authoritative Dependencies

- [Settings & Project Lifecycle](./settings-project-lifecycle.md) supplies parent project states,
  ownership, archive/restore/delete boundaries, and settings metadata consumed by environment state.
- [Organization & Workspace Model](./organization-workspace-model.md) supplies organization,
  workspace, project, tenant, and environment ownership vocabulary.
- [developer-experience.md#plan-07](./developer-experience.md#plan-07) defines dashboards, CLI, and
  status surfaces that later consume environment lifecycle state.
- [platform-engineering.md#plan-25](./platform-engineering.md#plan-25) defines environments,
  drivers, packs, and GitOps/pipeline context without placing runtime work in this M0 record.
- [security-networking.md#plan-50](./security-networking.md#plan-50) defines tenant and app
  security/networking boundaries.
- [Support SLA Channels](./support-sla-channels.md) defines support handoff boundaries.
- [Backup & Restore](./backup-restore.md) supplies restore evidence vocabulary.
- [Resource Garbage Collection](./resource-garbage-collection.md) supplies cleanup handoff vocabulary.
- [ADR-0077](./adr/02-identity-security.md#adr-0077), [ADR-0079](./adr/02-identity-security.md#adr-0079),
  [ADR-0080](./adr/02-identity-security.md#adr-0080), and
  [ADR-0042](./adr/07-portability-extensibility.md#adr-0042) pin projects/environments,
  app tenancy, tenant isolation, and local-dev fidelity boundaries.

## Owning Initiative Dependencies

| Owner | Consumes from Environment Lifecycle | Boundary |
|---|---|---|
| Environment Lifecycle | Accepted taxonomy, lifecycle states, transition-owner matrix, evidence fields, and M1 proof gate. | This issue defines scope; it does not build the environment service. |
| Settings & Project Lifecycle | Parent project state, project ownership, archive/restore/delete boundaries, and settings metadata. | Project lifecycle implementation remains outside Environment Lifecycle. |
| Admin Console | Environment state and approval intent for later admin visibility. | Admin screens, approvals, and client flows remain outside this M0 record. |
| Deployment Dashboard & Topology Explorer | Environment state and last deployment/topology signal. | Dashboard implementation and topology visualization remain outside this M0 record. |
| Tenant Isolation & Quotas | Environment tenant boundaries. | Quota accounting, noisy-neighbor controls, and enforcement remain separate. |
| Backup & Restore | Restore-pending and restore-point evidence. | Backup and restore drills or runtime behavior remain separate. |
| Resource Garbage Collection | Archived, deleting, and deleted-terminal cleanup handoffs. | Live cleanup, teardown, and provider sweepers remain separate. |
| Support Workflow | Customer-safe lifecycle state, owner, evidence gaps, and escalation fields. | Ticketing and SLA automation remain separate. |

## Evidence Required For M1

| Evidence | Owner | Proof mode | Proves |
|---|---|---|---|
| Environment schema | Environment Lifecycle | Design record | Environment classes, lifecycle states, parent project, tenant, owner, and policy fields are stable. |
| Lifecycle state machine | Environment Lifecycle | Contract test | Requested, blocked, active, suspended, archived, restore-pending, deleting, and terminal states transition deterministically. |
| Transition-owner matrix | Environment Lifecycle | Reference fixture | Create, activate, suspend, archive, restore, delete, fork, and promote decisions route to named owners. |
| Audit event fixture | Environment Lifecycle | Audit fixture | Lifecycle changes emit owner/action/state evidence without implementing event storage. |
| Support export contract | Support Workflow | Support handoff | Support can inspect customer-safe state, owner, limitation, unresolved evidence, and escalation path. |
| Scope boundary register | Environment Lifecycle | Audit fixture | Runtime, provider, admin, RBAC, quota, backup/restore, cleanup, and M1-M4 follow-up work route out. |

## Follow-Up Gate

M1/M2/M3/M4 environment lifecycle design, service, dashboard, admin, security, support, backup,
cleanup, or provider work must wait until this M0 scope record is accepted. This branch records the
gate and its executable guard; it does not create follow-up implementation issues.

Isolation tiers for each lifecycle class are defined in [ADR-0133](./adr/02-identity-security.md#adr-0133) (environment network isolation).
