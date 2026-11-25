# Orchestrator Reconciliation FSM — Architecture Evidence

Draft package for HOBO-620. Carries architecture-guard evidence per
`scripts/check-architecture-guardrails.mjs`.

## Schema and constraints

- Protobuf: [`architecture/orchestrator_reconciliation_fsm_contract.proto`](./architecture/orchestrator_reconciliation_fsm_contract.proto)
- CUE: [`architecture/orchestrator_reconciliation_fsm_contract.cue`](./architecture/orchestrator_reconciliation_fsm_contract.cue)
- PACT: [`architecture/pacts/orchestrator_reconciliation_fsm_contract.pact.json`](./architecture/pacts/orchestrator_reconciliation_fsm_contract.pact.json)

## Parse, don't validate

- `fixtureDeploymentPlan()` and `indexResources()` parse DeploymentPlan fixtures once at the orchestrator boundary.
- Illegal FSM transitions throw at the ResourceActor seam; callers receive typed transition errors instead of silent drift.

## Event architecture

| Role | This POC |
|---|---|
| Command | `run({ plan })` — reconcile desired plan through mocked executors |
| Event | `resource.*`, `deployment.Deployed`, `deployment.RolledBack`, compensation facts |
| Actor | One ResourceActor per plan node; Orchestrator coordinates choreography |
| Event store | In-memory transcript; replay via `replayOrchestration({ plan, events })` |
| Projection | `state.actors[]` materialized from event fold |
| Snapshot | Final `state` returned from `run()` |

NFR-011 replay: folding the full event transcript reproduces identical per-actor FSM states.

No runtime EventStore or ActorHost persistence is implemented here; the PACT names the S1-06 port boundary for promotion.
