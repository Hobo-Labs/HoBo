# Deployment Strategy Saga Orchestrator

Parse-don't-validate orchestrator composing strategy saga templates with
SLO-gated rollback analysis. Rollout events append to an in-memory event log;
metric-gate decisions emit `delivery.MetricAnalysisDecided` and
`policy.ObligationCreated` for replay.

Event architecture: CQRS rollout saga + metric-gate side stream. Gateway
commands are idempotent via rollout-scoped keys.

## Roles

| Persona | Goal | Reference behavior |
|---|---|---|
| Platform operator | Roll out multi-cloud-shop services with mixed strategies | Each service selects recreate, blue-green, canary, or progressive. |
| SRE on-call | Auto-rollback on regression | SLO burn and Golden-suite failure create event-sourced rollback obligations. |

## Boundary map

- `deployment-strategy-saga-templates-contract` — saga step compilation and gateway commands
- `slo-gated-rollback-analysis-contract` — metric gate verdict + policy obligations
- `progressive-delivery-harness` — harness fixture vocabulary for health/SLO scenarios

## Guardrail evidence

Parse, don't validate: service configs, scenario fixtures, and rollout inputs cross
`selectStrategyForService` / `toSloSample` parser boundaries before the orchestrator
runs saga steps. Parsed domain types bind `fromVersion` / `toVersion` targets; mock
gateway receives only derived types, not raw DTOs.

Event architecture: the ResourceActor issues rollout **commands** that emit `rollout.*`
**events** into an in-memory **event store**. `evaluateRolloutMetricGate` appends
`delivery.MetricAnalysisDecided` side-stream events. **Materialized views** /
**projections** (`replayGatewayState`, `replayMetricGateEvents`) rebuild current
**snapshots** from the append-only log; historical **snapshots** are retained in a
**read store** so promotion reads never infer state from mutable provider internals.
Rollback obligations block the actor until satisfied or escalated.
