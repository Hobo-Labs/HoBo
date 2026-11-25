---
type: Reference
title: "Deployment Dashboard & Topology Explorer Scope and Acceptance"
description: "Source issue: HOBO-410."
tags: [hobo, design]
---

# Deployment Dashboard & Topology Explorer Scope and Acceptance

Source issue: HOBO-410.

Executable proof lives in
[`src/draft/exp-proofs/ux/deployment-dashboard-topology-scope-contract`](../../src/draft/exp-proofs/ux/deployment-dashboard-topology-scope-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-410-deployment-dashboard-topology`](./proofs/hobo-410-deployment-dashboard-topology/README.md).

## M0 Acceptance Record

Deployment Dashboard & Topology Explorer owns the productization scope for
operator and developer read surfaces over deployment state, topology state, run
history, and follow-up actions. This M0 record defines the accepted scope and
evidence gate for later M1/M2/M3/M4 design and implementation slices. It does
not implement the production dashboard, a topology runtime, a projection engine,
or any live provider path.

## User And Business Goal

HoBo needs a dashboard and topology explorer where an operator can trust
deployment state, topology health, and next actions without leaving the accepted
projection model. The surface must expose what happened, what is current, what
is stale or unavailable, and which owner owns missing evidence. Business value is
faster launch diagnosis and safer operator trust without creating a second
source of truth beside the event log and projections.

## Primary Personas

| Persona | Need |
|---|---|
| Platform operator | Understand fleet, environment, and deployment health from projection-backed views. |
| Application developer | Inspect deploy timeline, topology, and plan/diff handoffs for their app. |
| Release owner | See whether rollout, rollback, or promotion evidence supports a release decision. |
| Support engineer | Correlate customer reports to event ids, projection snapshots, and owning actors. |
| Security reviewer | Confirm tenant, project, environment, and RBAC boundaries before reads become customer-visible. |

## Scope In

- M0 user and business goal for the deployment dashboard and topology explorer.
- Primary personas and the first operational questions each persona must answer.
- Projection-backed surface taxonomy for deployment timeline, topology graph,
  run inspector, project/environment fleet rollup, health/cost/incident rollup,
  and plan-diff entrypoint.
- Service, UX, security, and support boundaries mapped to existing design
  sources and owner initiatives.
- M1 evidence requirements before implementation follow-up issues can be
  created.
- Gap routing for adjacent runtime, data-plane, security, support, and CLI/MCP
  work.

## Scope Out And Non-Goals

- Do not build the production dashboard frontend, React application, visual
  graph renderer, or final UI components.
- Do not implement live provider calls, provider topology traversal, or resource
  graph resolution.
- Do not implement event projection engines, read stores, GraphQL facade,
  subscriptions, or dashboard read APIs.
- Do not publish public status pages or incident communications.
- Do not implement tenant authorization, RBAC, redaction, or policy engines.
- Do not automate support tickets, escalations, or support SLAs.
- Do not create M1-M4 design or implementation issues until this M0 record and
  proof are accepted.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | The dashboard consumes `DeploymentView`, `TopologyView`, `RunView`, `PlanDiffView`, availability, cost, and incident projections. It does not own projectors, event stores, live provider traversal, or GraphQL materialization. |
| UX | M0 defines information architecture and required states. It does not define production components, design-system implementation, or a final dashboard shell. |
| Security | Every read must be tenant-filtered before project/environment filtering, carry RBAC/redaction requirements, and surface freshness/staleness. This issue records the rule but does not implement enforcement. |
| Support | Support handoff evidence must name event ids, projection snapshots, actor owner, safe next action, and customer-safe wording. Support queues, SLAs, and automation remain support-owned. |

## Surface Taxonomy

| Surface | Projection source | Shows | M0 boundary |
|---|---|---|---|
| Deployment timeline | `DeploymentView`, deployment saga events, plan-diff summary | Declared, running, failed, rolled back, and completed deployment state with replay context. | Read-only projection taxonomy. |
| Topology graph | `TopologyView`, `ResourceLinkView`, environment view | Resource and dependency relationships without live provider traversal. | Projection snapshot only. |
| Run inspector | `RunView`, actor events, command envelopes | Commands, actors, attempts, durations, errors, and replay correlation. | No stream runtime or actor host implementation. |
| Project/environment fleet | `ProjectView`, `EnvironmentView`, tenant read scope | Project by environment rollups and tenant-bounded fleet comparison. | Requires tenant/RBAC proof before implementation. |
| Health/cost/incident rollups | `AvailabilityView`, cost signal view, incident signal view | Health, SLO, cost, and incident cues beside deploy and topology state. | Does not own alerting, billing, or incident workflows. |
| Plan-diff entrypoint | `PlanDiffView`, capability review, `can-deploy` decision | Handoff to plan, risk, and capability evidence when a deploy needs review. | Navigation and evidence map only. |

## Authoritative Dependencies

- [developer-experience.md#plan-07](./developer-experience.md#plan-07) defines
  deployment timeline, topology graph, run inspector, CLI inspect/logs/doctor,
  and MCP parity expectations.
- [developer-experience.md#plan-49](./developer-experience.md#plan-49) defines
  project/environment fleet views, status-page boundaries, availability, cost,
  incident, and health rollups.
- [control-plane.md#plan-04](./control-plane.md#plan-04) defines the control
  plane projection boundary and why reads should come from projections instead
  of live providers.
- [data-plane.md#plan-32](./data-plane.md#plan-32) defines event-sourced
  projections, read-store behavior, snapshot/replay expectations, and
  GraphQL/read facade boundaries.
- [reliability-observability-cost.md#plan-05](./reliability-observability-cost.md#plan-05)
  defines SLO, availability, telemetry, cost, and incident signals that the
  dashboard can display but must not own.
- [cli-spec.md](./cli-spec.md) defines the command vocabulary that must stay in
  parity with dashboard-visible read fields.
- [developer-experience.md#local-dashboard-hobo-dev](./developer-experience.md#local-dashboard-hobo-dev)
  and [ADR-0111](./adr/07-portability-extensibility.md#adr-0111) define the
  `hobo dev` local dashboard serving mode, local read path, view scope labels,
  OTLP ingest, and offline behavior — distinct from the hosted Yard Gateway
  dashboard path in [developer-experience.md#plan-07](./developer-experience.md#plan-07).
- [ADR-0077](./adr/02-identity-security.md#adr-0077) pins project/environment
  grouping and tenant-first filtering.
- [ADR-0078](./adr/02-identity-security.md#adr-0078) pins architecture-derived
  availability as a projection, not a public leak.
- [ADR-0050](./adr/03-data-plane.md#adr-0050) pins event-sourced data-plane
  projections and deterministic read behavior.
- [ADR-0089](./adr/03-data-plane.md#adr-0089) pins GraphQL facade generation as
  deterministic dispatch over materialized read models.

## Owning Initiative Dependencies

| Owner | Consumes from this M0 record | Boundary |
|---|---|---|
| Deployment Dashboard & Topology Explorer | Accepted surface taxonomy, persona goals, and M1 evidence gate. | Owns dashboard scope and later dashboard-specific design slices. |
| Developer Experience / CLI / MCP | Dashboard-visible fields that need CLI/MCP inspect or logs parity. | Owns commands and agent tool parity, not production dashboard rendering. |
| Control Plane | Topology, deployment, run, and plan-diff projection ownership. | Owns actors, planner/runtime events, and topology derivation. |
| Data Plane | Projection freshness, read-store, snapshot, and GraphQL/read facade semantics. | Owns projection engine and read model implementation. |
| Reliability, Observability & Cost | SLO, availability, cost, and incident signals surfaced in dashboard rollups. | Owns telemetry, alerting, cost attribution, and incident workflows. |
| Security / RBAC | Tenant-first filtering, project/environment RBAC, and redaction rules. | Owns authorization and redaction implementation. |
| Support Workflow | Handoff fields for customer diagnosis and safe next action. | Owns support queues, SLAs, and escalation automation. |

## Gap Routing

| Gap / adjacent concern | Routed to | Notes |
|---|---|---|
| `hobo dev` local dashboard serving mode, local read API, OTLP sink, offline scope labels | [developer-experience.md#local-dashboard-hobo-dev](./developer-experience.md#local-dashboard-hobo-dev), [ADR-0111](./adr/07-portability-extensibility.md#adr-0111) | Distinct from this M0 record's hosted/fleet dashboard scope; local dev telemetry is not a live-provider or Gateway read. |
| Aspire local-dashboard parity (resource graph, per-resource telemetry) | [`docs/competitors/aspire.md`](../competitors/aspire.md#dashboard-dcp--observability), [ADR-0111](./adr/07-portability-extensibility.md#adr-0111) | Reference competitor surface; HoBo closes via co-launched local listener. |
| Hosted Yard dashboard (Gateway read path) | [developer-experience.md#plan-07](./developer-experience.md#plan-07) | Next.js `web` resource in Yard Bindle; out of `hobo dev` scope. |
| Operations/fleet dashboard & status pages | [developer-experience.md#plan-49](./developer-experience.md#plan-49), [ADR-0077](./adr/02-identity-security.md#adr-0077) | Camp-backed; labeled `camp-deferred` in local dashboard. |

## Evidence Required For M1

| Evidence | Owner | Proof mode | Proves |
|---|---|---|---|
| Dashboard surface taxonomy | Deployment Dashboard & Topology Explorer | Design record | M1 slices share accepted surface names, projection sources, and scope boundaries. |
| Projection source map | Data Plane | Traceability | Every dashboard field names an event-sourced projection owner and freshness behavior. |
| Topology fixture | Control Plane | Fixture | Topology graph examples are projection snapshots rather than live provider scans. |
| Tenant/RBAC/staleness rules | Security / RBAC | Contract test | Tenant, project, environment, redaction, and stale-read behavior are explicit before customer-visible reads ship. |
| CLI/MCP parity map | Developer Experience / CLI / MCP | Design record | Dashboard fields have inspect/logs/doctor or MCP equivalents where users expect parity. |
| Support handoff map | Support Workflow | Traceability | Support runbooks can cite event ids, projection snapshots, owner, safe next action, and customer-safe wording. |

## Follow-Up Gate

M1/M2/M3/M4 design, implementation, UI, projection, provider, GraphQL, RBAC,
status-page, and support workflow issues must wait until this M0 scope record is
accepted. The executable guard in
[`deployment-dashboard-topology-scope-contract`](../../src/draft/exp-proofs/ux/deployment-dashboard-topology-scope-contract/README.md)
rejects follow-up creation when M0 is not accepted and rejects scope text that
tries to implement production UI, live providers, projection runtime, status
publishing, or RBAC inside this M0 issue.
