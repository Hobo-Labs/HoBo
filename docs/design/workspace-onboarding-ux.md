---
type: Reference
title: "Workspace & Onboarding UX Scope and Acceptance"
description: "Source issue: HOBO-409."
tags: [hobo, design]
---

# Workspace & Onboarding UX Scope and Acceptance

Source issue: HOBO-409.

Executable proof lives in
[`src/draft/exp-proofs/ux/workspace-onboarding-scope-acceptance`](../../src/draft/exp-proofs/ux/workspace-onboarding-scope-acceptance/README.md).
Branch evidence is summarized in
[`proofs/hobo-409-workspace-onboarding-scope`](./proofs/hobo-409-workspace-onboarding-scope/index.md).

## M0 Acceptance Record

Workspace & Onboarding UX owns the first-run product rail from invite or anonymous try-it path to
workspace creation, project creation, plan preview, launch attempt, recovery, and value proof. This
M0 record defines what evidence later M1 design and contract issues must produce before downstream
implementation work can claim the v1 onboarding path is ready.

## User And Business Goal

HoBo needs a launch-safe onboarding path that shows a new user what to do next, what is blocked, who
owns the missing prerequisite, and what evidence proves the next stage is real. The scope must make
the first-run experience comparable across hosted HoBo, self-hosted Yard, example-app, and customer
pilot paths without hiding service, security, billing, support, or operations work inside the UX
project.

## Primary Personas

| Persona | Need |
|---|---|
| First-time app developer | Move from workspace creation to first safe plan and deploy evidence without cloud-provider setup. |
| Team admin | Understand organization, member, project, and environment decisions before inviting others. |
| Platform engineer | See when provider defaults, approved catalogs, policy gates, and inferred-Camp approval are prerequisites. |
| Support operator | Diagnose stalled onboarding from explicit state, failure reason, owner, and evidence source. |

## Scope In

- First-run activation rail from invite or anonymous try-it path through workspace, project, plan
  preview, deploy attempt, recovery, and value proof.
- Workspace and project lifecycle states that onboarding UX may show before implementation issues
  exist.
- Persona-specific boundaries for app developer, team admin, platform engineer, and support
  operator paths.
- M1-ready evidence map for onboarding scenarios, telemetry events, state model, recovery fixtures,
  and support handoff.

## Scope Out And Non-Goals

- Do not build the dashboard, settings screens, account service, auth flow, billing flow, or
  production instrumentation.
- Do not create customer onboarding scripts, support runbooks, notification copy, or launch
  marketing pages.
- Do not provision live infrastructure, use live customer data, or claim production activation
  metrics.
- Do not create M1-M4 implementation issues before this M0 scope record is accepted.
- Do not replace the role walkthrough, worked example, or Example Apps proof-mode record.
- Do not define final visual design, UI copy, or accessibility audit output.
- Do not resolve billing, entitlement, compliance, legal, support, or incident-communication policy.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Workspace onboarding defines state and evidence contracts only; account, auth, billing, notification, and project services remain in their owner projects. |
| UX | UX scope is journey and acceptance shape, not final screens, design-system components, or dashboard implementation. |
| Security | Onboarding cannot bypass auth, policy, provider approval, inferred-Camp approval, or no-static-key rules to make first run look successful. |
| Support | Support handoff records stalled state, owner, safe next action, and evidence source; support scripts and SLAs remain separate. |

## Authoritative Dependencies

- [vision.md#plan-17](./vision.md#plan-17) defines the competitive need for ruthless onboarding and
  Lakebed-level first-run clarity.
- [developer-experience.md#plan-07](./developer-experience.md#plan-07) defines the `hobo new`,
  `hobo dev`, `hobo up`, plan, inspect, logs, and doctor surfaces that onboarding exposes.
- [walkthrough.md](./walkthrough.md) defines hosted HoBo cloud versus self-hosted Yard prerequisites
  and the app-developer first-run path.
- [worked-example.md#plan-19](./worked-example.md#plan-19) supplies the `snapshop` activation
  fixture.
- [example-apps.md](./example-apps.md) supplies proof modes and example command paths that onboarding
  can consume.
- [ADR-0064](./adr/07-portability-extensibility.md#adr-0064) keeps monetization/business mechanics
  outside this platform scope record.

## Owning Initiative Dependencies

| Owner | Consumes from Workspace & Onboarding UX | Boundary |
|---|---|---|
| Workspace & Onboarding UX | Accepted activation rail, first-run state model, and UX proof requirements. | This issue defines scope and acceptance; implementation waits for later phases. |
| Settings & Project Lifecycle | Project creation, environment selection, and settings states feed onboarding entry and exit criteria. | Settings screens and lifecycle APIs remain outside onboarding M0. |
| Organization & Workspace Model | Organization, workspace, member, and invite states are prerequisites for team onboarding. | Org model implementation and RBAC behavior remain outside onboarding M0. |
| Example Apps | Accepted examples provide first-run fixtures and command paths. | Onboarding consumes example proof modes; it does not build examples. |
| Customer Onboarding | Pilot scripts can reuse the first-run rail and success/failure categories. | Customer scripts, pilot notes, and customer-success process stay in Customer Onboarding. |
| Support Workflow | Support handoff needs stalled-state and evidence fields from onboarding. | Support SLA, queues, and escalation process stay in Support Workflow. |
| V1 Release Program & Cutline | Readiness dashboard and go/no-go records classify onboarding gaps by blocker category. | Release decisions, accepted risks, and launch notes stay in the cutline project. |

## Evidence Required For M1

| Evidence | Owner | Proof mode | Proves |
|---|---|---|---|
| Activation rail map | Workspace & Onboarding UX | Design record | Each stage has an entry condition, exit condition, evidence object, and owning project. |
| Persona first-run scenarios | Workspace & Onboarding UX | Reference fixture | App developer, admin, platform engineer, and support paths can be exercised without hidden local knowledge. |
| Workspace state model | Organization & Workspace Model | Contract test | Workspace, project, environment, and provider-readiness states cannot appear green when missing. |
| Telemetry event contract | Workspace & Onboarding UX | Telemetry contract | Activation events have privacy constraints, support use, and product question ownership. |
| Recovery and handoff fixtures | Support Workflow | Support handoff | Blocked onboarding states carry safe next action, owner, and evidence source for support. |

## Follow-Up Gate

M1/M2/M3/M4 design, implementation, instrumentation, and support-workflow issues must wait until
this M0 record is accepted. This branch records the gate and its executable guard; it does not create
follow-up implementation issues.
