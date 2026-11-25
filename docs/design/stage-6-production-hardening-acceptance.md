---
type: Reference
title: "Stage 6 Production Hardening Acceptance"
description: "Source issue: S6-01."
tags: [hobo, design]
---

# Stage 6 Production Hardening Acceptance

Source issue: S6-01.

Branch evidence:

- [`build-s6-01-stage6-acceptance proof record`](./proofs/build-s6-01-stage6-acceptance/README.md)

Promoted draft proofs (executable evidence; not modified by this record):

- [`reliability-observability-cost-finops`](../../src/draft/epic-proofs/reliability-observability-cost-finops/README.md)
- [`finops-budget-routing-control-plane`](../../src/draft/epic-proofs/finops-budget-routing-control-plane/README.md)
- [`progressive-delivery-harness`](../../src/draft/epic-proofs/progressive-delivery-harness/README.md)
- [`operators-sre-crew`](../../src/draft/epic-proofs/operators-sre-crew/README.md)
- [`contracts-policy-governance`](../../src/draft/epic-proofs/contracts-policy-governance/README.md)

Design sources: [Plan 05 — Reliability, Observability & Cost](./reliability-observability-cost.md#plan-05), [FinOps budget routing control plane](./finops-budget-routing-control-plane.md), [Plan 07 — Developer Experience](./developer-experience.md#plan-07), [Plan 40 — Operators & SRE](./operators-sre.md#plan-40), [Plan 46 — Governance planes](./governance-planes.md#plan-46), archived [roadmap Stage 6](../archive/roadmap.md#stage-6--ha-finops-ux--governance-planes), and archived [requirements Stage 6 release criterion](../archive/requirements/requirements.md#release-criteria-single-v1-definition-of-done).

## Stage Goal And Gate Authority

Stage 6 (Production Hardening) is the final build stage of HoBo v1: it lands control-plane HA, multi-region DR, deployment-strategy sagas, the FinOps plane, the full dashboard, the governance planes, and the Operator Crew on top of the stage-0..5 core. This M0 acceptance record pins scope in/out, ratifies the stage-6 design hooks (consensus, RPO/RTO, region topology, canary auto-rollback), names the five promoted epic proofs, restates the stage gate, and blocks follow-up implementation until reviewers accept it. **S6-02..S6-10 stay blocked until this record is merged and indexed.**

## Restated Stage Gate

### Requirements release criterion (Stage 6)

Source: [`docs/archive/requirements/requirements.md`](../archive/requirements/requirements.md#release-criteria-single-v1-definition-of-done)

> canary auto-rollback; plan-time cost within tolerance; DR rebuild < RTO; full dashboard + accessibility (NFR-016); and the governance planes usable — a `notify` send is event-sourced + consent-gated, a classified field drives an enforced residency/retention obligation with crypto-shred erasure, a guardrail blocks a flagged model output, and a certified Registry listing installs via Matching (uncertified stays unlisted).

### Roadmap acceptance gate (Stage 6)

Source: [`docs/archive/roadmap.md`](../archive/roadmap.md#stage-6--ha-finops-ux--governance-planes)

> a canary with an injected health regression auto-rolls-back + blue/green flip+soak works; plan-time cost estimate within tolerance + a budget breach blocks/requires approval; kill a Yard node → deploy resumes < target + DR rebuild from replicated log < target RTO; dashboard renders every view from projections only; a `notify` send is event-sourced + deferred by a quiet-hours obligation, a classified field drives an enforced residency/retention obligation + erasure crypto-shreds its key, a guardrail blocks a flagged output, an uncertified Registry listing stays unlisted while a certified one installs via Matching.

## Ratified Stage-6 Hooks

These decisions resolve the roadmap Stage-6 "Key risk/hook" line: *consensus choice (own Raft vs the Camp store) + RPO/RTO targets; active-active vs active-passive; canary health-signal sources + the auto-rollback decision function.* They match the design suite defaults in [Plan 05](./reliability-observability-cost.md#plan-05); any deviation requires written rationale plus an ADR delta.

| Hook | Decision |
| --- | --- |
| Consensus (own Raft vs Camp store) | Conformance-gated delegation: any backend hosting the Yard's authoritative log must pass the `@hobo/conformance` linearizable quorum-fenced-append assertion; the built-in engine ships its own small Raft; `runtime-postgres` delegates to synchronous quorum replicas. No separate consensus service. |
| RPO/RTO commitments | Ratify the Plan-05 targets table as commitments: control-plane availability 99.9% single-region / 99.95% multi-region; deploy resume after node loss < 30s (lease TTL + tail replay); RPO ≈ 0 (sync quorum) / ≤ 5s (async tier); RTO (full Yard rebuild from replicated log) < 15 min. |
| Active-active vs active-passive | Authoritative log: single-writer quorum replication (active-passive semantics) with the stateless tier (Gateway, Planner, Executors) horizontally scaled active-active. Cross-Camp app state: declared topologies per [ADR-0040](./adr/01-architecture-core.md#adr-0040) (single-writer-Camp / active-active-eventual CRDT / pinned), surfaced as labeled bounded-staleness reads. |
| Canary health-signal sources + auto-rollback decision function | Signals: data-plane runtime metrics/streams, provider health checks, SLO error-budget burn ([ADR-0045](./adr/02-identity-security.md#adr-0045)), continuous Golden-suite results. Decision function: the rollout gate is a `step` with a timeout and a rollback compensation; a burn/Golden-suite breach auto-rolls-back as a policy obligation, otherwise promotes. |

## Scope In

Seven stage-6 implementation lanes and their planned production homes (scope declarations only — no code in S6-01):

| Lane | Production home | Scope declaration |
| --- | --- | --- |
| Control-plane HA + multi-region DR | `packages/cloud` (`@hobo/cloud`, the Yard) | Quorum event-store replication, leader election, actor leases + fencing, cross-region log replication, DR replay (`hobo up ./platform --restore <log>`), and conformance-gated control-plane backends ([Plan 05 §Control-plane HA](./reliability-observability-cost.md#control-plane-ha), [Plan 05 §Disaster recovery](./reliability-observability-cost.md#disaster-recovery)). |
| Deployment-strategy sagas | `packages/cloud` | Recreate, blue-green, canary, and progressive rollout as parameterized saga templates behind the `hobo:delivery` port ([ADR-0083](./adr/02-identity-security.md#adr-0083)); health-gated promotion and auto-rollback ([Plan 05 §Deployment strategies](./reliability-observability-cost.md#deployment-strategies-as-reusable-saga-templates), [ADR-0044](./adr/02-identity-security.md#adr-0044)). |
| FinOps plane | `packages/cloud` | MeteringView, CreditLedgerView, budgets/caps, spend breaker, degradation sagas (`spend.Degradation*`), showback, plan-time cost estimate, and the FinOps budget routing control-plane contract ([Plan 05 §Cost & FinOps](./reliability-observability-cost.md#cost--finops), [ADR-0039](./adr/02-identity-security.md#adr-0039), [finops-budget-routing-control-plane](./finops-budget-routing-control-plane.md)). |
| Full dashboard | `apps/dashboard` | All views as projection-only reads; WCAG 2.1 AA + pseudo-localization ([NFR-016](../archive/requirements/requirements.md)); "Everything is a view over events" ([Plan 07](./developer-experience.md#plan-07)). |
| `notify` port (cloud messaging) | `packages/cloud` | Consolidated `hobo:notify` cloud-messaging port in the resource catalog — event-sourced, consent-gated sends with rate/quiet-hours obligations ([ADR-0059](./adr/03-data-plane.md#adr-0059)); **not** a Plan 46 governance plane ([ADR-0064](./adr/07-portability-extensibility.md#adr-0064) §3). |
| Governance planes (Plan 46) | `packages/cloud`, `packages/registry`, `packages/policy` | Compliance enforcement ([ADR-0060](./adr/02-identity-security.md#adr-0060)), AI safety/guardrails ([ADR-0061](./adr/02-identity-security.md#adr-0061)), Registry distribution ([ADR-0062](./adr/07-portability-extensibility.md#adr-0062)); classification → enforced residency/retention; crypto-shred erasure ([Plan 46](./governance-planes.md#plan-46)). |
| Operator Crew | `packages/sdk` (`@hobo/sdk`), `packages/agent-skills` (`@hobo/agent-skills`) | Built-in Yard services: SVID-bearing principals, event-sourced, MCP-surfaced, engine behind a port, human-in-the-loop by default for write actions ([ADR-0054](./adr/03-data-plane.md#adr-0054), [Plan 40](./operators-sre.md#plan-40)). |

## Scope Out And Non-Goals

- No implementation code in S6-01 — this issue ships documentation records only.
- Marketplace monetization is out of scope ([ADR-0064](./adr/07-portability-extensibility.md#adr-0064)); app/UI generation (UX Designer, design.md, OpenUI, json-render, mcp-apps, `ui-render` port) stays in the ADR-0064 keep list ([ADR-0056](./adr/03-data-plane.md#adr-0056)).
- HoBo charges no money and ships no billing ([ADR-0064](./adr/07-portability-extensibility.md#adr-0064)).
- No edits to the five promoted epic proofs under `src/draft/epic-proofs/`.
- Each excluded implementation lane is owned by one of **S6-02..S6-10** and must not start until this record is accepted.

## Promoted Proofs

| Epic proof | Proves | Run command |
| --- | --- | --- |
| [`reliability-observability-cost-finops`](../../src/draft/epic-proofs/reliability-observability-cost-finops/README.md) | Telemetry/SLO rollback, FinOps budget guard, saga compensation, golden chaos rollup; 8 Pact boundaries across Plan 05, ADR-0045, ADR-0039, ADR-0083. | `npm --prefix src/draft/epic-proofs/reliability-observability-cost-finops test` |
| [`finops-budget-routing-control-plane`](../../src/draft/epic-proofs/finops-budget-routing-control-plane/README.md) | Metric-contract governance, constraint-first Pareto routing, stability controller, DecisionGraph; 7 Pact boundaries. | `npm --prefix src/draft/epic-proofs/finops-budget-routing-control-plane test` |
| [`progressive-delivery-harness`](../../src/draft/epic-proofs/progressive-delivery-harness/README.md) | Policy-gated flag flip, 10/50/100 canary splits, SLO promote/hold/rollback, rollback-compensation negatives. | `npm --prefix src/draft/epic-proofs/progressive-delivery-harness test` |
| [`operators-sre-crew`](../../src/draft/epic-proofs/operators-sre-crew/README.md) | SRE self-healing via gated canary, human-in-the-loop approval, fail-closed runaway guard, DR failover with fencing/RPO/replay certification. | `npm --prefix src/draft/epic-proofs/operators-sre-crew test` |
| [`contracts-policy-governance`](../../src/draft/epic-proofs/contracts-policy-governance/README.md) | Gatekeeper deny-ceiling, mandatory gates, fail-closed policy uncertainty, governance conformance replay. | `npm --prefix src/draft/epic-proofs/contracts-policy-governance test` |

## Evidence Required For The Implementation Slices

Downstream S6-02..S6-10 slices inherit these guardrails. Each lane must carry executable PACT consumer/provider contracts at every service boundary (`contracts/` per package), protobuf-first records with CUE constraints in each package-local `data-models/` folder (no repo-wide catalog), parse-don't-validate derived types at boundaries, CQRS/event-sourced state (actors emit append-only events, never mutate read models), and inward-only dependency layering `apps → adapters → sdk/runtime → core` with `@hobo/core` depending on nothing HoBo ([NFR-020](../archive/requirements/requirements.md)).

| Lane | Required evidence |
| --- | --- |
| Control-plane HA + DR | `@hobo/conformance` linearizable quorum-fenced-append assertion for any control-plane backend; split-brain safety via quorum + fencing; DR rebuild from replicated log replays all streams and rehydrates projections + actors — "DR is just replay" ([Plan 05 §Control-plane HA](./reliability-observability-cost.md#control-plane-ha), [Plan 05 §Disaster recovery](./reliability-observability-cost.md#disaster-recovery)); cross-Camp topologies per [ADR-0040](./adr/01-architecture-core.md#adr-0040); component-host conformance ([ADR-0031](./adr/01-architecture-core.md#adr-0031)). |
| Deployment-strategy sagas | Parameterized saga templates behind `hobo:delivery` ([ADR-0083](./adr/02-identity-security.md#adr-0083)); rollout gate as `step` with timeout + rollback compensation; auto-rollback on SLO burn ([ADR-0045](./adr/02-identity-security.md#adr-0045)) + Golden-suite breach as policy obligation ([ADR-0044](./adr/02-identity-security.md#adr-0044)); health signals from data-plane metrics/streams and/or provider health checks. |
| FinOps plane | Plan-time cost within tolerance; budgets/caps as policy gates; ordered degradation tiers (`nominal`→`reduced`→`minimal`, `spend.Degradation*` saga) before runaway-spend breaker ([ADR-0039](./adr/02-identity-security.md#adr-0039)); ResourceIntent → DecisionGraph → ActionPlan pipeline ([finops-budget-routing-control-plane](./finops-budget-routing-control-plane.md)); OTLP/CloudEvents/OCSF boundary export ([ADR-0046](./adr/02-identity-security.md#adr-0046)). |
| Full dashboard | Projection-only reads — rebuild every view from the event log with no privileged state ([Plan 07](./developer-experience.md#plan-07)); WCAG 2.1 AA + pseudo-localization ([NFR-016](../archive/requirements/requirements.md)); derivative upgrade paths ([ADR-0057](./adr/07-portability-extensibility.md#adr-0057)). |
| `notify` port (cloud messaging) | `notify` sends event-sourced + consent-gated ([ADR-0059](./adr/03-data-plane.md#adr-0059)); consolidated cloud-messaging port per [ADR-0064](./adr/07-portability-extensibility.md#adr-0064) §3 — not a Plan 46 governance plane. |
| Governance planes (Plan 46) | Classification drives **enforced** residency/retention at `can-deploy` + runtime ([ADR-0060](./adr/02-identity-security.md#adr-0060)); crypto-shred erasure on forward-only log (no event rewritten); guardrails enforced default with **no off switch** ([ADR-0061](./adr/02-identity-security.md#adr-0061)); certified Registry listing installs via Matching, uncertified stays unlisted ([ADR-0062](./adr/07-portability-extensibility.md#adr-0062)); Registry distribution never gates portability ([ADR-0064](./adr/07-portability-extensibility.md#adr-0064)). |
| Operator Crew | Built-in Yard services ([ADR-0054](./adr/03-data-plane.md#adr-0054)); SVID-bearing principals; MCP-surfaced; engine behind a port; human-in-the-loop by default for write actions; SLO-as-code gating ([ADR-0045](./adr/02-identity-security.md#adr-0045)); incident/self-healing via gated canary + auto-rollback ([Plan 40](./operators-sre.md#plan-40)). |

## Follow-Up Gate

Do not create or start S6-02..S6-10 implementation work until reviewers accept this Stage-6 acceptance record.
