---
type: Reference
title: "Teardown & Recovery Scope And Acceptance"
description: "Source issue: HOBO-444."
tags: [hobo, design]
---

# Teardown & Recovery Scope And Acceptance

Source issue: HOBO-444.

Executable proof lives in
[`src/draft/exp-proofs/dx/teardown-recovery-scope-acceptance`](../../src/draft/exp-proofs/dx/teardown-recovery-scope-acceptance/README.md).
Branch evidence is summarized in
[`proofs/hobo-444-teardown-recovery`](./proofs/hobo-444-teardown-recovery/README.md).

## M0 Acceptance Record

Teardown & Recovery defines the launch-critical product record for safe teardown states,
dependency-drain evidence, recovery decisions, cleanup handoffs, support handoffs, and follow-up
proof gates. It gives downstream design/build work a stable boundary before any production teardown,
restore, provider delete, or support workflow implementation starts.

It does not build a teardown runner, provider delete adapter, restore service, support workflow,
billing/refund process, customer notification path, or downstream M1-M4 implementation issue.

## User And Business Goal

HoBo needs accepted M0 scope for teardown and recovery so platform engineers, SRE operators,
support operators, security reviewers, and customer admins know what evidence is required before a
project, environment, deployment, or resource can be described as safe to tear down or recover. The
record must support launch planning without claiming production teardown or recovery readiness.

## Primary Personas

| Persona | Need |
|---|---|
| Platform engineer | Know the teardown boundary, affected scope, dependency drain state, cleanup handoff, and rollback posture before implementation work begins. |
| SRE operator | Resume or recover interrupted teardown paths with explicit idempotency, rollback, restore, and escalation evidence. |
| Support operator | Route stalled teardown or recovery states with customer-safe owner, limitation, evidence gap, and next action. |
| Security reviewer | Confirm destructive-action policy, audit, tenant-boundary, and no-live-mutation guarantees before teardown is customer visible. |
| Customer admin | Understand what HoBo can claim about teardown, terminal state, recoverability, and unsupported states. |

## Scope In

- Teardown states: requested, blocked, draining, teardown-ready, recoverable, terminal, and
  escalated.
- Dependency-drain evidence for dependents, active operations, leases, queue work, traffic,
  incidents, provider-state uncertainty, and customer-visible impact.
- Recovery decision modes: resume, rollback, restore-from-evidence, and manual escalation.
- Cleanup handoff evidence for residual resources, orphan candidates, unknown provider state, and
  resource-garbage-collection eligibility.
- Service, UX, security, and support boundaries for downstream M1 design and contract proof.
- Follow-up gate that blocks M1-M4 teardown/recovery implementation issues until M0 scope and
  acceptance are recorded.

## Scope Out And Non-Goals

- Do not build production teardown runners, provider delete adapters, provider mutation, live cloud
  deletes, restore runtimes, or destructive execution.
- Do not execute backup restore, disaster recovery, upgrade rollback, migration rollback, customer
  data recovery, or live environment mutation.
- Do not implement support queues, SLA automation, helpdesk integration, customer notifications, or
  incident command workflows.
- Do not define refunds, invoices, chargebacks, tax behavior, billing cancellation, or commercial
  offboarding.
- Do not create downstream M1-M4 design or implementation issues before this M0 scope record is
  accepted.

Non-goals:

- Replace Environment Lifecycle, Resource Garbage Collection, Backup & Restore, Upgrade &
  Migration Engine, or Support Workflow records.
- Treat a terminal product state as proof that provider resources were destroyed.
- Claim production teardown or recovery readiness before deterministic M1 fixtures prove the path.
- Use live provider credentials, live customer data, or destructive provider calls in M0.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Teardown & Recovery owns state vocabulary, drain evidence, recovery decisions, cleanup handoffs, support handoffs, and proof gates; runtime execution is later work. |
| UX | This record defines future labels, warnings, evidence states, and information architecture only; screens, routes, and interactions stay later. |
| Security | Destructive-action policy, tenant boundary, credential handling, and audit decisions stay with policy/governance owners; M0 names required evidence. |
| Support | Support receives safe state, owner, limitation, and escalation evidence; support queues, notifications, and SLA workflow stay separate. |

## Teardown States

| State | Meaning | M1 proof expectation |
|---|---|---|
| Requested | Teardown intent exists but scope, owner, dependency, backup, or policy evidence is incomplete. | Schema fixture records owner and missing evidence. |
| Blocked | Teardown cannot proceed because dependency, policy, incident, backup, support, or provider-state evidence is unresolved. | Contract test refuses teardown-ready claims while blockers remain. |
| Draining | Later implementation may drain dependents, traffic, queues, jobs, or leases; M0 records expected evidence only. | Drain matrix names dependency classes and owner handoffs. |
| Teardown-ready | Required owner, scope, drain, policy, backup/rollback, cleanup, and support evidence exists. | Decision table can authorize future destructive work without executing it. |
| Recoverable | Recovery evidence names resume, rollback, restore-from-evidence, or escalation before terminal claims. | Recovery table maps mode to proof source and owner. |
| Terminal | Product lifecycle ended without claiming provider resources were removed. | Audit proof distinguishes product terminal state from provider cleanup. |
| Escalated | State is ambiguous or unsafe, so support/SRE/security/human handoff is required. | Support export preserves limitation, owner, next action, and evidence gap. |

## Recovery Modes

| Mode | Meaning | Boundary |
|---|---|---|
| Resume | Continue an interrupted teardown after idempotency and dependency evidence are present. | Does not implement teardown runtime. |
| Rollback | Return to the last accepted product state using deployment or upgrade rollback evidence. | Does not implement rollback execution. |
| Restore-from-evidence | Reference accepted Backup & Restore evidence and unsupported-state limitations. | Does not implement restore runtime. |
| Manual escalation | Route unresolved states to named support/SRE/security owners. | Does not implement support workflow. |

## Required Evidence

| Evidence | Owner | Proves |
|---|---|---|
| Owner | Teardown & Recovery | Tenant, workspace, project, environment, and accountable actor are known. |
| Scope | Environment Lifecycle | Project, environment, deployment, resource, and support-visible impact boundaries are explicit. |
| Last-known state | Control Plane | Latest accepted product, resource, and deployment state is recorded before teardown or recovery. |
| Dependency drain | Control Plane | Dependents, active operations, leases, queues, traffic, and incidents are named. |
| Backup or rollback reference | Backup & Restore | Restore point, rollback evidence, unsupported state, or limitation is explicit before recovery claims. |
| Cleanup handoff | Resource Garbage Collection | Residual resources and orphan candidates route to cleanup eligibility evidence. |
| Support handoff | Support Workflow | Customer-safe explanation, limitation, escalation owner, and next action are available. |
| Policy decision | Contracts, Policy & Governance | Destructive-action allow, deny, hold, or escalation evidence is recorded. |

## Authoritative Dependencies

- [control-plane.md#plan-04](./control-plane.md#plan-04) defines ResourceActor state,
  dependency graphs, compensation choreography, and future teardown execution ownership.
- [reliability-observability-cost.md#plan-05](./reliability-observability-cost.md#plan-05)
  defines recovery, reliability, incident, and replay expectations consumed by teardown evidence.
- [developer-experience.md#plan-07](./developer-experience.md#plan-07) defines inspect, dashboard,
  and support-facing surfaces that may later show teardown state.
- [platform-engineering.md#plan-25](./platform-engineering.md#plan-25) defines environments,
  drivers, packs, GitOps, and pipeline context that teardown must not implement in M0.
- [environment-lifecycle.md](./environment-lifecycle.md) supplies lifecycle state vocabulary,
  environment ownership, archive/delete/restore boundaries, and support export expectations.
- [resource-garbage-collection.md](./resource-garbage-collection.md) supplies orphan, residue,
  cleanup eligibility, policy-window, and sweeper handoff vocabulary.
- [backup-restore.md](./backup-restore.md) supplies restore point, drill evidence, RPO/RTO, and
  unsupported recovery limitations.
- [upgrade-migration-engine.md](./upgrade-migration-engine.md) supplies upgrade rollback,
  migration dry-run, compatibility blocker, and recovery evidence vocabulary.
- [support-sla-channels.md](./support-sla-channels.md) defines support routing, unsupported
  request, escalation, and customer-safe response language.
- [ADR-0004](./adr/01-architecture-core.md#adr-0004), [ADR-0006](./adr/01-architecture-core.md#adr-0006),
  [ADR-0058](./adr/03-data-plane.md#adr-0058),
  [ADR-0041](./adr/07-portability-extensibility.md#adr-0041), and
  [ADR-0094](./adr/02-identity-security.md#adr-0094) pin choreography compensation,
  orphan-sweep state honesty, SRE/recovery posture, adopt/import boundaries, and autonomous-action
  safety rails.

## Owning Initiative Dependencies

| Owner | Consumes from Teardown & Recovery | Boundary |
|---|---|---|
| Teardown & Recovery | Accepted state vocabulary, dependency drain evidence, recovery decision table, cleanup handoff, and M1 proof gate. | This issue defines scope and acceptance; it does not build runners, providers, restores, or support tools. |
| Environment Lifecycle | Environment owner, archive/delete/restore state, and support-safe lifecycle boundaries. | Environment services and admin UX remain separate. |
| Resource Garbage Collection | Residual resource and orphan-candidate handoff evidence. | Live cleanup, eligibility state machine, and provider sweepers remain separate. |
| Backup & Restore | Restore point, rollback, RPO/RTO, and unsupported recovery evidence. | Restore drills, backup services, and recovery runtime stay separate. |
| Upgrade & Migration Engine | Upgrade rollback, migration dry-run, compatibility blocker, and upgrade recovery evidence. | Migration planning and rollback execution stay separate. |
| Support Workflow | Customer-safe routing, limitation, escalation, and next-action evidence. | Support queues, SLAs, tickets, and notifications stay separate. |
| Control Plane | ResourceActor state, dependency graph, compensation choreography, and future teardown execution. | Runtime and provider dispatch remain future implementation work. |
| Contracts, Policy & Governance | Destructive-action policy, deny ceilings, obligations, audit, and policy-decision evidence. | Policy engine and authorization runtime remain outside this issue. |

## Evidence Required For M1

| Evidence | Owner | Proof mode | Proves |
|---|---|---|---|
| Teardown state schema | Teardown & Recovery | Design record | Teardown states, recovery modes, owner, scope, dependency, policy, cleanup, and support evidence fields are stable. |
| Dependency drain matrix | Control Plane | Reference fixture | Dependents, active operations, traffic, leases, incidents, and provider uncertainty block teardown until named evidence exists. |
| Recovery decision table | Teardown & Recovery | Contract test | Resume, rollback, restore-from-evidence, and manual escalation decisions are deterministic and proof-backed. |
| Cleanup handoff fixture | Resource Garbage Collection | Audit fixture | Residual resources and orphan candidates route to cleanup rather than silent provider mutation. |
| Support escalation export | Support Workflow | Support handoff | Support can export customer-safe state, limitation, owner, evidence gap, and next action. |
| Scope boundary register | Contracts, Policy & Governance | Policy fixture | Provider deletes, runtime execution, restore services, billing, support tooling, and downstream issue creation route out. |

## Follow-Up Gate

M1/M2/M3/M4 teardown/recovery design, service, provider, restore, cleanup, support, policy, billing,
or customer-notification work must wait until this M0 scope record is accepted. This branch records
the gate and its executable guard; it does not create follow-up implementation issues.
