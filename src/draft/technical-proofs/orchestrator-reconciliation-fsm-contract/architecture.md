# Orchestrator Reconciliation FSM — Architecture Evidence

| Capability | Persona | Assertion | Linear |
|---|---|---|---|
| DAG-order provisioning | Release manager | Fixture DeploymentPlan converges through mocked executor apply calls in dependency order. | HOBO-620 |
| Reverse compensation | SRE operator | Mid-DAG failure emits `deployment.RolledBack` and destroys provisioned resources reverse-topologically. | HOBO-620 |
| Event replay | Platform engineer | Full event transcript replays to identical ResourceActor FSM states (NFR-011). | HOBO-620 |

## Parse, don't validate

Untrusted DeploymentPlan fixtures cross one parser boundary in `indexResources()` and become derived domain types with validated dependency graphs. Downstream orchestrator code accepts parsed resource maps, not raw DTO arrays with repeated checks.

## Event architecture

| Role | This POC |
|---|---|
| **Command** | `run({ plan })` requests reconcile of desired plan through mocked executors. |
| **Event** | `resource.*`, `deployment.Deployed`, `deployment.RolledBack` facts append to the in-memory transcript. |
| **Actor** | One ResourceActor per plan node; Orchestrator coordinates choreography across actors. |
| **Event store** | In-memory event transcript; `eventLog` replays through `replayOrchestration()`. |
| **Materialized view / projection** | `state.actors[]` folds events into current FSM states and deployment status. |
| **Snapshot** | Final `state` returned from `run()` is the query snapshot of the projection. |
| **Read store** | Tests and callers query `state` rather than re-deriving from raw executor audit logs. |

## Boundaries

| Boundary | Provider | PACT |
|---|---|---|
| ActorHost lease | In-memory lease mock | `architecture/pacts/orchestrator_reconciliation_fsm_contract.pact.json` |
| Executor apply/destroy | `createMockExecutor()` | same |
