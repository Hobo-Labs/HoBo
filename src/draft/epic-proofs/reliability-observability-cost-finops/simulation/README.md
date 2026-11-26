# Reliability Simulation

## Running the epic simulation

Command:

```bash
npm.cmd --prefix src/draft/epic-proofs/reliability-observability-cost-finops run simulate
```

What this proves:

- `telemetry-slo-gate`: trace context is repaired, telemetry exports are deterministic, stale SLI data fails closed, and SLO burn creates a rollback decision.
- `finops-budget-guard`: metering, credit headroom, budget/quota policy, showback, runaway-spend circuit breaking, and observability cost shedding compose without live billing services.
- `saga-compensation-recovery`: partial deploy failure is classified, compensated in reverse dependency order, and inspected through deterministic replay.
- `golden-chaos-status-rollup`: Golden Suite and chaos evidence folds into reliability status without a live chaos platform.

Mocked boundaries:

- `TelemetryBoundaryExport`: CloudEvents, OTLP, metrics, and structured log sinks are in memory.
- `TraceContextQueue`: queue handoff is simulated with deterministic trace/span ids.
- `SloPolicyGate`: SLO and rollback policy evaluation runs locally.
- `MeteringCreditLedger`: MeteringView, CreditLedgerView, showback, and shared-cost allocation use fixture events.
- `BudgetQuotaPolicyGate`: budget/quota, runaway spend, and observability-cost decisions are local evaluators.
- `SagaCompensationBoundary`: saga steps and provider destroy calls are in-memory mocks.
- `GoldenChaosBoundary`: Golden Suite and fault injection evidence are deterministic fixtures.
- `ReliabilityStatusRollup`: Run Inspector and SLA status views are folded from fixture events.

Contracts:

- `contracts/pacts/telemetry-boundary-export.pact.json`
- `contracts/pacts/trace-context-queue.pact.json`
- `contracts/pacts/slo-policy-gate.pact.json`
- `contracts/pacts/metering-credit-ledger.pact.json`
- `contracts/pacts/budget-quota-policy-gate.pact.json`
- `contracts/pacts/saga-compensation-boundary.pact.json`
- `contracts/pacts/golden-chaos-boundary.pact.json`
- `contracts/pacts/reliability-status-rollup.pact.json`
