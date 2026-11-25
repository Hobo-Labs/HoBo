# Reliability, Observability & Cost Reference Implementation

Epic: `b36b40c8-059f-4d29-8aa1-0a80c852761a`

This reference implementation rolls PLAN-05 POCs into one executable architecture for reliability, observability, and FinOps. It is not production code. It proves the epic shape with mocked internal and external service boundaries, Pact fixtures, and a deterministic simulation harness.

## Vertical Slices

```gherkin
Feature: Telemetry-backed SLO rollback

  Persona: SRE on-call

  Scenario: Deploy burn creates a rollback obligation
    Given a deployment emits trace-correlated telemetry and SLO samples
    When the deploy success SLO exhausts its error budget
    Then the policy gate returns rollback and records fail-closed stale-data behavior
```

```gherkin
Feature: FinOps budget guard

  Persona: FinOps lead

  Scenario: Spend pressure degrades safely before runaway spend expands
    Given metered usage, credit headroom, and quota policy fixtures
    When the projected period spend crosses a cost availability tier
    Then the reference policy allows degraded execution and trips runaway-spend protection on sustained velocity
```

```gherkin
Feature: Saga compensation recovery

  Persona: Incident commander

  Scenario: Partial deploy failure compensates only provisioned resources
    Given a deployment saga provisioned network and database resources
    When the API resource fails across the no-go threshold
    Then compensation destroys database before network and Run Inspector exposes replay evidence
```

```gherkin
Feature: Golden chaos status rollup

  Persona: SRE on-call

  Scenario: Golden Suite and chaos evidence feeds reliability status
    Given runtime-local and Camp Golden Suite targets pass
    When node-loss chaos preserves the steady-state invariant
    Then the rollup keeps status evidence explicit and fails closed on blast-radius leaks
```

## Service Boundaries

| Boundary | Mock strategy | Contract |
|---|---|---|
| TelemetryBoundaryExport | In-memory CloudEvents, OTLP, metrics, and structured log projections | `contracts/pacts/telemetry-boundary-export.pact.json` |
| TraceContextQueue | Deterministic trace/span id queue handoff | `contracts/pacts/trace-context-queue.pact.json` |
| SloPolicyGate | Local SLO computation, rollback analysis, and gaming guard | `contracts/pacts/slo-policy-gate.pact.json` |
| MeteringCreditLedger | Fixture MeteringView and CreditLedgerView projections | `contracts/pacts/metering-credit-ledger.pact.json` |
| BudgetQuotaPolicyGate | Local budget/quota, runaway-spend, and observability-cost evaluators | `contracts/pacts/budget-quota-policy-gate.pact.json` |
| SagaCompensationBoundary | In-memory saga execution and provider destroy callbacks | `contracts/pacts/saga-compensation-boundary.pact.json` |
| GoldenChaosBoundary | Deterministic Golden Suite and fault-injection evidence | `contracts/pacts/golden-chaos-boundary.pact.json` |
| ReliabilityStatusRollup | Event-folded SLA status and Run Inspector projections | `contracts/pacts/reliability-status-rollup.pact.json` |

## Running the Epic Simulation

```bash
npm.cmd --prefix src/draft/epic-proofs/reliability-observability-cost-finops run simulate
```

## Verification

```bash
npm.cmd --prefix src/draft/epic-proofs/reliability-observability-cost-finops test
```

## What Is Real

- POC modules are imported and executed from `src/draft/<kind>/<slug>`.
- Pact-style fixtures cover every declared reference boundary.
- The validated SLO gaming guard proof is included in this rollup; its deterministic simulation contract is unchanged.
- `proof.json` pins the validated cost-degradation saga and connectivity cost feedback proofs in this rollup; their deterministic simulation contracts are unchanged.
- The simulation runs four epic-level slices with deterministic fixtures.

## What Is Mocked

- No live telemetry backend, queue, SLO service, billing API, provider API, chaos platform, or status page is called.
- Provider side effects are in-memory callbacks.
- Contract providers are unavailable and documented as mocked in `contracts/pact-inventory.md`.

## Follow-Ups

- Wire provider verification once production boundary services exist.
- Split cross-epic connectivity and progressive-delivery policy details back to their owning epics.
- Promote stable reference slices into production packages only after package ownership is decided.
- **HOBO-660:** S6-05 observability drift loop draft POC at
  [`s6-05-observability-drift-loop-contract`](../../technical-proofs/s6-05-observability-drift-loop-contract/README.md)
  exercises OTLP export, SLO burn alerts, and drift heal/propose/ignore in an E2E lane.


OpenInference trajectory-capture and reliability-SLA changes are absorbed without changing telemetry, status, or rollback behavior.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Reliability Observability Cost Finops.
- `architecture/pacts/` — PACT contract for the package boundary.
- `architecture.md` — parse-don't-validate and event-architecture evidence.

## Cascade reconciliation (83d9b5c92)

The run-inspector, spend-circuit-breaker, shared-cost, showback, SLO, and structured-log technical proof refreshes are absorbed without changing reliability, observability, or FinOps evidence.
