---
type: Reference
title: "Plan/Diff Viewer Scope and Acceptance"
description: "Source issue: HOBO-411."
tags: [hobo, design]
---

# Plan/Diff Viewer Scope and Acceptance

Source issue: HOBO-411.

Executable proof lives in
[`src/draft/exp-proofs/ux/plan-diff-viewer-scope-acceptance`](../../src/draft/exp-proofs/ux/plan-diff-viewer-scope-acceptance/README.md).
Branch evidence is summarized in
[`proofs/hobo-411-plan-diff-viewer-scope`](./proofs/hobo-411-plan-diff-viewer-scope/README.md).

## M0 Acceptance Record

Plan/Diff Viewer owns the productization scope for reviewing deployment plans and plan changes before
any deploy path claims launch readiness. This M0 record defines what later M1 design and contract
issues must prove before HoBo can present plan review, risk, cost, and approval evidence as a
customer-facing surface.

## User And Business Goal

HoBo needs a plan review surface that lets users understand what will change, why a plan is safe or
blocked, which owner must resolve missing evidence, and which assertions are live, estimated,
unavailable, or out of scope. The scope must keep the viewer from silently absorbing planner,
dashboard, approval, billing, provider, or support implementation work.

## Primary Personas

| Persona | Need |
|---|---|
| App developer reviewer | Understand what changed in a proposed deployment before approving or revising it. |
| Platform engineer approver | Validate provider, environment, topology, capacity, and cost deltas without running apply. |
| Security reviewer | See policy, credential, permission, and data-boundary impacts before a plan can proceed. |
| Support operator | Diagnose blocked or confusing plan states from a stable evidence object and owner map. |

## Scope In

- Plan and diff review scope for DeploymentPlan, ResourcePlan, topology, policy, cost, and approval
  evidence.
- Persona-specific review states for app developer, platform engineer, security reviewer, and
  support operator paths.
- Service, UX, security, and support boundaries for what the viewer may claim at M0.
- M1-ready evidence map for fixtures, annotations, copy, and support handoff records.

## Scope Out And Non-Goals

- Do not implement planner, matcher, provisioner, apply, rollback, or live provider integrations.
- Do not build the production dashboard, final UI components, command implementation, or approval
  workflow.
- Do not call live cloud cost APIs, store provider credentials, or execute infrastructure changes.
- Do not create M1-M4 design or implementation issues before this M0 scope record is accepted.
- Do not replace the DeploymentPlan IR, Matching, or control-plane planner contracts.
- Do not define billing, entitlement, quota, or marketplace payout behavior.
- Do not claim production launch readiness from static mocks or incomplete plan evidence.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Plan/Diff Viewer defines review evidence and state contracts only; planner, matcher, provisioner, billing, and approval services remain in their owner projects. |
| UX | UX scope is information architecture, review states, and acceptance shape, not final dashboard implementation or design-system components. |
| Security | Viewer output must not hide policy denials, broadened permissions, provider credentials, tenant data exposure, or missing approval evidence. |
| Support | Support handoff records blocked state, owner, safe next action, and evidence source; support workflow and SLA commitments remain separate. |

## Authoritative Dependencies

- [developer-experience.md#plan-07](./developer-experience.md#plan-07) defines the `hobo plan`,
  `hobo up`, inspect, and approval-facing surfaces that the viewer explains.
- [control-plane.md#plan-04](./control-plane.md#plan-04) defines DeploymentPlan, ResourcePlan,
  Matching, Planner, and control-plane evidence boundaries.
- [platform-engineering.md#plan-25](./platform-engineering.md#plan-25) defines environments,
  provider mapping, GitOps, and operator concerns consumed by plan review.
- [reliability-observability-cost.md#plan-05](./reliability-observability-cost.md#plan-05) defines
  cost, observability, SLO, and readiness signals that cannot be represented as generic green states.
- [contracts-policy-flags.md#plan-29](./contracts-policy-flags.md#plan-29) defines policy gate,
  obligation, and compatibility context that must appear in risky diffs.
- [ADR-0033](./adr/01-architecture-core.md#adr-0033) pins deterministic Matching and Planner
  selection so plan diffs can be stable and explainable.
- [ADR-0064](./adr/07-portability-extensibility.md#adr-0064) keeps monetization and business
  mechanics outside this platform plan-review scope record.

## Owning Initiative Dependencies

| Owner | Consumes from Plan/Diff Viewer | Boundary |
|---|---|---|
| Plan/Diff Viewer | Accepted M0 review contract, evidence states, and viewer-specific acceptance criteria. | This issue defines scope and acceptance; implementation waits for later phases. |
| Deployment Dashboard & Topology Explorer | Dashboard surfaces can consume accepted plan and topology diff states. | Dashboard layout, navigation, and production UI implementation remain outside this M0 issue. |
| Workspace & Onboarding UX | Onboarding can use plan review outcomes as first-run activation and recovery checkpoints. | First-run instrumentation and onboarding rails remain in Workspace & Onboarding UX. |
| Security Verification | Security launch gates can rely on explicit policy, credential, permission, and tenant-boundary annotations. | Security test execution, vulnerability triage, and compliance signoff remain outside Plan/Diff Viewer M0. |
| Support & Debug Tools | Support surfaces can reuse blocked-plan owner, safe-action, and evidence-source fields. | Support workflows, queues, debug tooling, and SLAs remain in support-owned projects. |
| V1 Release Program & Cutline | Readiness and go/no-go records can classify plan-review gaps by blocker category. | Launch decisions, accepted risks, and release notes stay in release-readiness projects. |

## Evidence Required For M1

| Evidence | Owner | Proof mode | Proves |
|---|---|---|---|
| Plan/diff state model | Plan/Diff Viewer | Design record | Each viewer state has an input, output, owner, missing-evidence behavior, and release-gate meaning. |
| Golden plan fixtures | Control Plane | Reference fixture | Stable plan and diff examples cover create, update, no-op, destructive, and blocked-plan paths. |
| Risk and policy annotations | Security Verification | Contract test | Policy denials, widened permissions, tenant exposure, and missing approvals cannot be hidden in generic plan output. |
| Cost and capacity summary | Reliability, Observability & Cost | Reference fixture | Cost, capacity, and SLO-impact summaries are explicit about known, estimated, unavailable, and stale evidence. |
| Blocked-plan support handoff | Support & Debug Tools | Support handoff | Blocked or confusing plan states carry owner, safe next action, customer-visible wording, and evidence source. |

## Follow-Up Gate

M1/M2/M3/M4 design, implementation, dashboard, command, approval, and live-provider issues must wait
until this M0 record is accepted. This branch records the gate and its executable guard; it does not
create follow-up implementation issues.
