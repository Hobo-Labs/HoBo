---
type: Reference
title: "V1 Outcome Activation Rail"
description: "Source issue: HOBO-508."
tags: [hobo, design]
---

# V1 Outcome Activation Rail

Source issue: HOBO-508.

Executable proof lives in
[`src/draft/technical-proofs/v1-outcome-activation-rail-contract`](../../src/draft/technical-proofs/v1-outcome-activation-rail-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-508-outcome-activation-rail`](./proofs/hobo-508-outcome-activation-rail/README.md).

## M0 Acceptance Record

The v1 outcome activation rail defines how a user moves from a plain-language desired outcome to
safe proof, plan review, launch guardrails, monitoring, and value evidence. It composes existing
HoBo surfaces so the proof path feels continuous without creating another product shell or a new
workflow engine.

## User And Business Goal

HoBo needs a compact v1 activation path that makes proof inspectable for non-expert buyers/users
and technical operators. The rail should explain what is safe to try, what evidence exists, what is
blocked, and which owning project receives the next handoff.

## Activation Stages

| Stage | Entry | Exit | Personas | Evidence | Handoff |
|---|---|---|---|---|---|
| Outcome capture | User has workspace access or an anonymous try-it path. | Plain-language desired outcome and persona label are recorded. | Non-expert buyer/user, app developer evaluator | `activation.outcome`, `workspace.profile` | Workspace & Onboarding UX, Customer Onboarding |
| Safe test selection | Outcome is classified by risk, persona, and supported template path. | Safe-test fixture and proof mode are selected before any live launch claim. | Non-expert buyer/user, security reviewer | `safe-test.fixture`, `proof-mode.declaration` | Example Apps, Security Verification |
| Plan review | A collected manifest or accepted fixture exists. | Plan/diff, topology, cost, warnings, and approval requirements are visible. | Technical operator, platform engineer | `deployment.plan`, `topology.summary`, `approval.requirement` | Plan/Diff Viewer, Deployment Dashboard & Topology Explorer |
| Launch with guardrails | Plan review has no launch-blocking unknowns or unapproved risky actions. | Launch status, rollback path, and policy/cost gate outcomes are captured. | Technical operator, support/operator | `deployment.status`, `policy.decision`, `cost.guardrail` | Deployment Dashboard & Topology Explorer, Support & Debug Tools |
| Value proof | A launched or simulated outcome has telemetry and support-visible evidence. | User-facing value proof, operator evidence, docs link, and follow-up owner are recorded. | Non-expert buyer/user, technical operator, customer/buyer | `activation.value-proof`, `telemetry.summary`, `docs.handoff` | Workspace & Onboarding UX, Launch Documentation, Support Workflow |

## Required Proof Surfaces

| Surface | Source project | Existing capability consumed |
|---|---|---|
| Onboarding | Workspace & Onboarding UX | Workspace creation, persona labels, first-run profile, and activation events. |
| Plan/diff | Plan/Diff Viewer | DeploymentPlan, topology/cost diff, warnings, and approval obligations. |
| Deployment status/topology | Deployment Dashboard & Topology Explorer | Deployment status, topology view, rollout state, and recovery visibility. |
| Safe tests | Example Apps | Safe fixtures, proof modes, and example command paths before public claims. |
| Cost/approval gates | Contracts/Policy/FinOps | Cost caps, policy decisions, approvals, and can-deploy gate outcomes. |
| Telemetry | Workspace & Onboarding UX | Activation funnel, first-run telemetry, and value-evidence events. |
| Support | Support Workflow | Support/debug handoff, escalation route, unsupported state classification. |
| Docs | V1 Release Notes & Upgrade Guide | Known limitations, getting-started path, release-note and support links. |

## Audience Views

| Audience | Visible | Hidden |
|---|---|---|
| Non-expert buyer/user | Plain-language outcome, selected safe test, ready/blocked launch state, value proof summary. | Raw topology graph, provider-specific plan internals, policy rule expression, internal support routing. |
| Technical operator | Plan diff, topology summary, approval gates, telemetry facts, evidence object IDs. | Marketing copy and buyer-only simplifications. |

## Scope In

- Define activation rail stages, entry/exit criteria, persona labels, evidence objects, and
  handoff projects.
- Map the rail to existing onboarding, plan/diff, deployment topology/status, safe-test, cost,
  approval, telemetry, support, and docs surfaces.
- Define what a non-expert buyer/user sees versus what a technical operator sees.
- Record the rail as a UX orchestration layer over existing capabilities.
- Gate M1-M4 follow-up implementation issues until this M0 record is accepted.

## Scope Out And Non-Goals

- Do not implement a workflow engine, state machine runtime, or orchestration backend.
- Do not build a duplicate product shell over the dashboard, onboarding, support, or docs surfaces.
- Do not implement telemetry collection, deployment execution, policy gates, or support tooling in
  this issue.
- Do not create M1-M4 implementation issues before M0 acceptance.

## Authoritative Dependencies

- [developer-experience.md#plan-07](./developer-experience.md#plan-07) defines dashboard, CLI,
  plan, up, inspect, logs, and human/agent parity surfaces.
- [worked-example.md#plan-19](./worked-example.md#plan-19) keeps the outcome story tied to the
  end-to-end `snapshop` path.
- [example-apps.md](./example-apps.md) supplies safe-test proof modes and example command paths.
- [traceability.md](./traceability.md) owns the durable plan/ADR-to-proof map.
- [ADR-0064](./adr/07-portability-extensibility.md#adr-0064) keeps product UI generation and broad
  business mechanics outside the platform scope.

## Follow-Up Gate

M1/M2/M3/M4 design or implementation issues must wait until this M0 rail record is accepted. This
branch records the gate and its executable guard; it does not create follow-up implementation
issues.
