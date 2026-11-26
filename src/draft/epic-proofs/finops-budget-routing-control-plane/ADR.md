# ADR: Standards-first FinOps routing control plane

Status: Accepted for draft proof

## Context

HoBo already has strong FinOps proof slices: `cost.json` estimates, MeteringView,
CreditLedgerView, budget/quota policy, cost-routing eligibility, showback,
shared-cost attribution, cost-driven degradation, and runaway-spend protection.
The missing shape is a public, provider-neutral control-plane contract that joins
those signals into an explainable routing decision.

The aggregated design critique rejected a naive "budget router plus weighted
score" because arbitrary metrics, weighted scalar optimization, and uncontrolled
feedback loops would create unstable, opaque decisions.

## Decision

The proof models the router as a standards-first, multi-stage decision system:

```text
ResourceIntent -> CandidateGeneration -> ConstraintFilter -> PolicyDecision
-> MetricVector -> ParetoFrontier -> PreferenceSelection -> StabilityDecision
-> DecisionGraph -> RoutingDecision -> ActionPlan -> ExecutionAdapter
-> FeedbackLoop
```

The core contract is provider-neutral. Concrete providers, SKUs, regions,
accounts, stacks, and backend APIs are rejected before routing, and execution
adapters translate only backend-neutral `ActionPlan` instructions.

Metrics use three tiers: immutable system metrics, approved derived metrics, and
approval-gated user metrics that only compose prior tiers. Routing is
constraint-first, then policy-gated, then Pareto-based. Preference weights only
select within the Pareto frontier. A stability controller can block churn. Every
decision emits a `DecisionGraph` consumed by DX, OpsX, and FinX views.

## Consequences

- The proof stays buildable with current open standards and HoBo draft package
  rules.
- The router is explainable and deterministic under replay.
- Feedback can propose metric or policy evolution, but cannot mutate it directly.
- Backend adapters remain mocked because production provider execution is out of
  scope for this proof.

## 2026-10-29 — Make the claimed routing invariants executable

The adversarial review found that latency was never filtered, a dominated
incumbent lost stability protection, empty registries still produced metric
claims, and candidate-relative normalization changed existing scores. The proof
also printed fixed audit references unrelated to its inputs.

Canonical inputs now live in `data-models/` and generate the parser's runtime
records. `architecture/` mirrors those records for the existing evidence path;
a byte-equality test prevents two independent contracts. CUE fixtures run at the
schema boundary. No lower technical proof interface changed; the epic's
independent decision contract is the changed atomic unit.

Money is parsed at six-decimal USD precision, added in integer microdollars,
and includes existing/unresolved/recovery exposure plus the entire proposed
hosting commitment. Ranking uses expected operating+transition cost; hard
admission uses the conservative commitment bound. This remains a read-only
proof, not an authoritative reservation service.

Metric semantics and normalization are versioned and fixed. The parser checks
unique identities, approved compositions, dependency cycles, finite values,
explicit periods and content-addressed evidence. Stability uses the currently
feasible incumbent, not the Pareto frontier, and applies net improvement,
migration penalty, cooldown, dwell evidence and flip limits independently.

The action is a proposal with existing `EffectSpec` and `ResilienceProfile`
metadata: pure decision, noRollback external mutation, no blind mutation retry,
bounded observation retry, and reconciliation/readback on unknown outcomes.
Executing and settling those effects remains the production supervisor's job.

The loopback acceptance proof measures completed requests at every applied ramp
and restoration. Each phase observes five requests and the total must reach at
least twenty with zero failures. Elapsed sleeps alone were insufficient evidence
under concurrent validation load because request throughput varies with load.
