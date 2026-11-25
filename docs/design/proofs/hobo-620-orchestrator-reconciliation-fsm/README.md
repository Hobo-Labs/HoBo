---
type: Reference
title: "HOBO-620 Orchestrator Reconciliation FSM Proof"
description: "Source issue: HOBO-620."
tags: [hobo, design]
---

# HOBO-620 Orchestrator Reconciliation FSM Proof

Draft POC for S2-05: Orchestrator + ResourceActors with reconciliation FSM and compensation sagas.

## Branch evidence

- Issue: HOBO-620
- Draft package:
  [`src/draft/technical-proofs/orchestrator-reconciliation-fsm-contract`](../../../../src/draft/technical-proofs/orchestrator-reconciliation-fsm-contract/README.md)
- Focused gate:
  `pnpm --prefix src/draft/technical-proofs/orchestrator-reconciliation-fsm-contract test`

## Acceptance mapping

| Issue acceptance | Proof |
|---|---|
| Fixture plan converges through mocked executors | BDD test provisions network→database→api in DAG order; mock executor audit log matches apply sequence |
| Mid-DAG failure compensates in reverse order | Injected `api` apply failure triggers `deployment.RolledBack` and destroy order `[api, database, network]` |
| Every transition event-replayable to identical state (NFR-011) | `replayOrchestration()` fold matches live `state.actors` FSM states |
| ResourceActor FSM on ActorHost port | Lease acquired before `resource.Provisioning`; adversarial second writer rejected |
| Promotes epic reconciliation scenarios | Reuses control-plane event vocabulary; architecture protobuf/CUE/PACT evidence |

## Adversarial coverage

- Duplicate event id ignored on replay
- ActorHost lease conflict fails closed
- Destroy failure surfaces `compensation-failed` and `needs-human` status
- Stalled dependency blocks downstream without blocking independent subtrees

## Scope boundary

Production `packages/cloud/src/orchestrator/` promotion waits on S2-04 Planner merge. This POC does not import unmerged planner code.
