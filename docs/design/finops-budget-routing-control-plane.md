---
type: Design
title: "FinOps Budget Routing Control Plane"
description: "Post-core standards-first FinOps routing control-plane contract with metric governance, Pareto selection, stability, decision graphs, feedback governance, and DX/OpsX/FinX surfaces."
tags: [hobo, finops, routing, standards, control-plane]
---

# FinOps Budget Routing Control Plane

This post-core design delta turns the completed Reliability, Observability &
Cost FinOps work into a standards-first, multi-objective, explainable, and
stability-controlled infrastructure intent router.

The goal is not to rebuild the existing FinOps proofs. It is to add one public
control-plane contract that composes the existing cost, metering, credit ledger,
budget policy, degradation, spend breaker, showback, and attribution evidence.

The execution contract is [Budgeted cloud hosting transitions](./hosting-budget-transitions.md):
expected cost selects among feasible proposals, while a shared authority reserves bounded
exposure. EffectSpec and ResilienceProfile declarations govern mutation, observation,
recovery, retirement and settlement; unknown outcomes retain their financial commitments.

## Control-Plane Shape

The canonical pipeline is:

```text
ResourceIntent
-> CandidateGeneration
-> ConstraintFilter
-> PolicyDecision
-> MetricVector
-> ParetoFrontier
-> PreferenceSelection
-> StabilityDecision
-> DecisionGraph
-> RoutingDecision
-> ActionPlan
-> ExecutionAdapter
-> FeedbackLoop
```

The router core can understand only intent, capability, cost model, meter,
budget, policy, event, plan, decision, action, state, metric contract, Pareto
frontier, stability policy, decision graph, and feedback proposal concepts. It
must not depend on provider names, SKUs, concrete regions, account IDs, stacks,
or backend API names. Those details live below the `ExecutionAdapterPort`
boundary.

## IfC and `hobo plan` spine

`ResourceIntent` is the FinOps pipeline's canonical input, but authors do not
write it directly. During **`hobo plan`** ([Plan 07](./developer-experience.md#plan-07)),
the Planner lowers each **manifest IR** resource node ([Plan 21](./authoring-resources-wiring.md#plan-21))
into one provider-neutral `ResourceIntent` before candidate generation begins:

```text
hobo collect (IfC) → hobo.manifest/v1
  → manifest→ResourceIntent bridge (Planner, read-only at plan time)
  → ResourceIntent → … → RoutingDecision + ActionPlan + DecisionGraph
  → DeploymentPlan DAG + plan-time cost (merged back into hobo plan output)
```

The bridge copies capability class (`port`/`type` + `require`/`prefer`),
budget scope, colocation/dependency edges from `bind`/`links`, and the tenant
routing objective from the manifest node and deploy context. Provider-specific
`.with(...)` annotations, SKUs, regions, and account identifiers **stay in the
manifest** and enter only after `RoutingDecision` via `ExecutionAdapter`. This
is the seam that connects P3 IfC authoring to P4 FinOps routing on the same
`hobo plan` spine the control plane documents ([Plan 04](./control-plane.md#plan-04)).
Executable bridge contract:
[`../../src/draft/technical-proofs/manifest-resource-intent-bridge-contract/README.md`](../../src/draft/technical-proofs/manifest-resource-intent-bridge-contract/README.md).

## Contract Model

The proof package at
[`../../src/draft/epic-proofs/finops-budget-routing-control-plane/README.md`](../../src/draft/epic-proofs/finops-budget-routing-control-plane/README.md)
owns Protobuf and CUE contract artifacts for these shapes:

- Existing FinOps spine: `ResourceIntent`, `Budget`, `BudgetScope`,
  `MeterDefinition`, `MeterMapping`, `FocusCostLedgerEntry`, `Forecast`,
  `BudgetRoutingPolicy`, `RoutingCandidate`, `RoutingDecision`, `ActionPlan`,
  `ApprovalRequest`, and `ExceptionGrant`.
- Multi-objective routing additions: `MetricContract`, `DerivedMetric`,
  `UserMetric`, `ConstraintResult`, `MetricVector`, `ParetoFrontier`,
  `PreferenceModel`, `StabilityPolicy`, `RoutingDecisionHistory`,
  `DecisionGraph`, `FeedbackProposal`, `MetricVersionChange`,
  `SimulationRequest`, and `SimulationResult`.

All untrusted input crosses one parser boundary before the router can use it.
The parsers enforce provider-neutral core inputs, metric contract semantics,
approved transforms, composition-only user metrics, versioned metric changes,
and backend-neutral action plans.

## Decision Semantics

Routing is constraint-first. Compliance, jurisdiction, security posture, max
cost, hard budget behavior, and eligibility constraints remove invalid
candidates before metrics or preference weights are considered. Policy then
returns allow, deny, approval-required, or transform obligations over valid
candidates and budget state.

The router does not use one global weighted score. It builds a Pareto frontier
across cost, reliability, latency, risk, and approved custom metrics. Preference
weights select only within the non-dominated set. A stability controller can
override a preferred candidate when hysteresis, cooldown windows, migration
penalties, flip limits, or routing history show unsafe churn.

Every decision emits a `DecisionGraph` with the candidates generated, candidates
rejected, constraint results, policy outcomes, metric vectors, Pareto frontier,
preference result, stability decision, final rationale, and audit references.
DX, OpsX, and FinX surfaces read that same graph rather than inventing separate
explanations.

## Metric Governance

Metrics use a three-tier model:

- Tier 0 system metrics have immutable semantics, units, sources,
  normalization, and versioning.
- Tier 1 derived metrics use approved transforms over Tier 0 or approved Tier 1
  inputs.
- Tier 2 user metrics are composition-only, require approval, and cannot consume
  raw telemetry directly.

Feedback from telemetry, actual cost, incidents, overrides, and deployment
outcomes creates `FeedbackProposal` records. Feedback never directly mutates
metric definitions, weights, or policy. Metric evolution requires an approved,
versioned `MetricVersionChange`.

## Standards Baseline

This design records the July 1, 2026 standards baseline:

| Concern | Standard baseline | Role in the proof |
|---|---|---|
| Cost and usage normalization | [FOCUS 1.4](https://focus.finops.org/what-is-focus/) | Normalized actual-cost ledger and import/export language |
| FinOps operating model | [FinOps Framework](https://www.finops.org/framework/) | Budgeting, forecasting, allocation, optimization, and anomaly vocabulary |
| Event envelope | [CloudEvents](https://github.com/cloudevents/spec) | Lifecycle, cost, usage, audit, and routing events |
| Delivery lifecycle events | [CDEvents](https://cdevents.dev/docs/) | CI/CD and deployment lifecycle semantics |
| Telemetry | [OpenTelemetry 1.58.0](https://opentelemetry.io/docs/specs/otel/) | Metrics, traces, logs, and correlation context |
| Synchronous API view | [OpenAPI 3.2.0](https://spec.openapis.org/oas/v3.2.0.html) | Generated public control-plane view |
| Event API view | [AsyncAPI 3.1.0](https://www.asyncapi.com/docs/reference/specification/latest) | Generated public event-channel view |
| Schema view | [JSON Schema 2020-12](https://json-schema.org/specification) and JSON-LD | Generated public schema and linked-data view |
| Embedded policy | [CEL](https://cel.dev/) | Default proof expression surface |
| Policy engine adapter | [OPA/Rego](https://www.openpolicyagent.org/docs/policy-language) | Optional adapter behind the policy-engine boundary |

FOCUS and OpenCost are captured as a standards research note in [`../standards/focus-opencost.md`](../standards/focus-opencost.md).

Terraform plan JSON, Pulumi Automation API, Crossplane compositions, and
Kubernetes/runtime controllers are fixture-only execution adapter boundaries.
Cloud-native budget APIs are signals, not hard enforcement guarantees.

## Product Surfaces

The proof exposes three surfaces over the same `DecisionGraph`:

- DX: intent spec, dry-run preview, simulation, and "why this placement?"
  explanation.
- OpsX: override, freeze, rollback, migrate, incident reroute, and blast-radius
  controls.
- FinX: budgets, forecasts, attribution, anomaly signals, commitments, and
  optimization recommendations.

The FinX forecasts, anomaly signals, and optimization recommendations are the advisory
`cost.ForecastUpdated`, `cost.AnomalyDetected`, and `cost.RecommendationIssued` facts computed by
the FinOps advisory plane ([Plan 5](./reliability-observability-cost.md#plan-05),
[ADR-0115](./adr/02-identity-security.md#adr-0115)); FinX reads them alongside the `DecisionGraph`
rather than inventing a separate computation. The FinX outputs are owned and actioned by the
**FinOps Crew operator** ([Plan 40](./operators-sre.md#plan-40), [ADR-0117](./adr/03-data-plane.md#adr-0117)), advisory-only; writes are gated.

## Scope Boundaries

Out of scope: billing, tax, payment collection, live provider billing sync,
production IaC, provider SDK calls, real cloud credentials, live-service E2E,
and production UI. The executable proof uses mocked Pact-style boundaries,
Protobuf/CUE contract evidence, deterministic fixtures, and offline tests.
