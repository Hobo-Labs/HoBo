---
type: Reference
title: "S2-01 Stage 2 First Cloud + Yard Proof"
description: "Source issue: S2-01."
tags: [hobo, design]
---

# S2-01 Stage 2 First Cloud + Yard Proof

This proof backs the M0 productionization record for
[Stage 2 Acceptance — First Cloud + Yard](../../stage-2-first-cloud-yard-acceptance.md).

## Branch Evidence

- Issue: HOBO-616 (S2-01)
- Promoted epic proofs (deterministic/mocked). Their proof logic and fixtures stay read-only for
  S2-01; the local `simulate` package scripts run through the same `tsx` loader as their tests so
  the documented `npm --prefix ... run simulate` gates resolve TypeScript sources on Node 24.

| Draft package | Focused gate |
|---|---|
| [`control-plane-planner-matching-orchestrator`](../../../../src/draft/epic-proofs/control-plane-planner-matching-orchestrator/README.md) | `npm --prefix src/draft/epic-proofs/control-plane-planner-matching-orchestrator run simulate` |
| [`providers-iac-build-adapters`](../../../../src/draft/epic-proofs/providers-iac-build-adapters/README.md) | `npm --prefix src/draft/epic-proofs/providers-iac-build-adapters run simulate` |
| [`data-plane-event-sourcing-cqrs-reactivity`](../../../../src/draft/epic-proofs/data-plane-event-sourcing-cqrs-reactivity/README.md) | `npm --prefix src/draft/epic-proofs/data-plane-event-sourcing-cqrs-reactivity run simulate` |
| [`contracts-policy-governance`](../../../../src/draft/epic-proofs/contracts-policy-governance/README.md) | `npm --prefix src/draft/epic-proofs/contracts-policy-governance run simulate` |

## Acceptance Mapping

| Runnable gate arm | Proof |
|---|---|
| Governed hello-bindle deploy to one real cloud (Gatekeeper before Delta→Set apply) | Control-plane epic (`match.Decided`, Delta→Set apply, ResourceActor reconcile) + providers/IaC epic (Cloudflare fixture, `realize()` → `IacProgram`/`BuildSpec`) + contracts-policy epic (Gatekeeper composite decision, `can-deploy`, deny-ceiling) |
| Yard killed mid-deploy resumes from event log; deployment timeline projection reconstructs the run | Data-plane epic (append-only events, replay==live, projections) + control-plane epic (event-sourced deployment lifecycle, dispatcher reservation safety) |
| Provisioning failure → saga compensation rolls back reverse-dependency order (`saga.Compensated`) | Control-plane epic (partial-realize rollback, choreography) + providers/IaC epic (partial-apply fail-closed paths) |
| Gatekeeper blocks unsafe/incompatible change with explainable event-sourced reason (`deployment.PlanRejected` / `compat.GateFailed` / `policy.Decided`; FR-050/051/052) | Contracts-policy epic (contract/policy/obligation gates, fail-closed on engine unavailability, replayable decision evidence) |

## Adversarial Coverage

The promoted proofs reject scope creep into live cloud calls, unsigned provider behavior,
Gatekeeper bypass at apply time, read-model mutation instead of event append, optimistic drift
auto-remediation, and grouped-stack compensation that cannot destroy individual resources.
Malicious-provider, poison-event, and engine-unavailability paths fail closed in the epic simulations.
