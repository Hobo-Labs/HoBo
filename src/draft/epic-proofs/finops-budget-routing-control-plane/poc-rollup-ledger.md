# Proof Rollup Ledger

| Lower proof family | Role in this epic | Reuse mode |
|---|---|---|
| `cost-signal-contract` | `cost.json` estimate and cost event vocabulary | Referenced as plan-time estimate fixture |
| `metering-view-projection-contract` | Usage and spend projection input | Referenced as MeteringView fixture shape |
| `credit-ledger-view-contract` | Effective marginal cost and credit headroom | Referenced as forecast input |
| `dispatcher-maximize-credits-contract` | Dispatcher cost objective and deterministic decision evidence | Reused conceptually in preference and replay tests |
| `dispatcher-reservation-hardening-contract` | Reservation and double-spend guardrails | Reused as stability and history context |
| `budget-quota-policy-contract` | Budget allow, deny, approval, and audit behavior | Reused as policy gate semantics |
| `cost-routing-eligibility-contract` | Single-writer and placement eligibility constraints | Reused as hard constraint fixture |
| `runaway-spend-circuit-breaker-contract` | Last-resort spend breaker behavior | Reused as hard budget handoff scenario |
| `cost-degradation-saga-contract` | Cost-driven graceful degradation | Reused as budget soft-limit action vocabulary; refreshed for the validated leaf hardening, with simulation and Pact evidence unchanged |
| `showback-attribution-contract` | FinX allocation and showback view | Reused in FinX surface projection |
| `shared-cost-attribution-contract` | Multi-tenant shared-cost allocation | Reused in FinX surface projection |
| `observability-cost-guard-contract` | Telemetry cost protection | Reused in metric governance scenarios |

This epic proof does not copy lower-layer logic. It composes their public
decision concepts into a standards-first router contract and records any future
compatibility change as a lower-layer ADR before changing those packages.
