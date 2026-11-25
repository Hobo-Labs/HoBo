# S6-05 Observability Drift Loop Contract

HOBO-660 proof for the observability plane (NFR-014): OTel logs/traces/metrics
with OTLP export, SLO burn-rate alerting, and the drift loop (periodic resync with
heal/propose/ignore surfaced via `hobo drift` and MCP `get_drift`/`heal`).

Promotes observability and drift scenarios from
[`reliability-observability-cost-finops`](../../epic-proofs/reliability-observability-cost-finops/README.md)
into an independent draft POC per
[`docs/design/reliability-observability-cost.md`](../../../../docs/design/reliability-observability-cost.md)
Plan 05.

## What This Proves

```gherkin
Feature: Observability plane E2E lane

  Scenario: Deploy and run traces export through OTLP
    Given control-plane deploy and data-plane run activity
    When telemetry pipelines flush to mock OTLP collectors
    Then deploy and run spans export and structured logs correlate to trace IDs

  Scenario: Seeded SLO burn fires an alert
    Given fixture SLI samples breaching burn-rate thresholds
    When SLO status materializes slo.BudgetBurned
    Then AlertManager-style routing emits alert.Fired and alert.Routed

  Scenario: Injected provider drift is detected and healed
    Given a periodic resync tick finds desired/observed divergence
    When heal policy routes through autonomous drift remediation
    Then drift.RemediationRouted events record the governed heal
```

## MCP / CLI Surfaces

| Surface | Operation | Proof |
|---|---|---|
| `hobo drift` / `get_drift` | Read drift projection | `getDrift({ resourceId, projection })` |
| `hobo drift --heal` / `heal` | Governed reconciliation | `healDrift({ resourceId, projection })` |

## Adversarial Coverage

- Healthy SLO samples do not emit burn alerts.
- `propose` drift policy opens `drift.DiffProposed` without auto-heal.
- `ignore` drift policy emits only `drift.Ignored`.

## Scope

In scope: OTLP trace/metric export, structured logs, SLO burn computation,
AlertManager-style burn alerts, drift scheduler tick, heal/propose/ignore routing,
MCP-shaped `get_drift`/`heal` helpers.

Out of scope: live telemetry backends, production control-plane HA (S6-02),
ResourceActor reconcile internals, real CLI/MCP servers, FinOps plane (S6-06).

## Verification

```bash
pnpm --prefix src/draft/technical-proofs/s6-05-observability-drift-loop-contract test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
