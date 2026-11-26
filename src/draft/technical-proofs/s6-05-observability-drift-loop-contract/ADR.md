# S6-05 Observability Drift Loop — Architecture Evidence

This draft package carries the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`, stating how its data is parsed and
how its records map onto the platform's event flow.

## Schema And Constraints

- Protobuf data shapes live in [`architecture/`](./architecture).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`architecture/pacts/`](./architecture/pacts) records the
  package's boundary.

## Parse, Don't Validate

Untrusted input is parsed once at the boundary into derived domain types
(resource drift signals, SLO definitions, alert signals). Downstream consumers
receive parsed types from existing contract modules (`slo-as-code-contract`,
`autonomous-drift-remediation-contract`, `alertmanager-routing-contract`) rather
than re-checking raw DTOs.

## Event Architecture

The package's accepted record is the read model behind a small event flow:

- **Command** — `healDrift` and periodic `runDriftSchedulerTick` requests reconcile
  drifted resources.
- **Event** — telemetry, `slo.BudgetBurned`, `alert.*`, `resource.DriftDetected`,
  and `drift.*` events append to the platform event store.
- **Actor** — the drift scheduler singleton and SLO evaluator actors own their
  respective command handlers.
- **Event store** — accepted events are appended as the durable source of truth.
- **Materialized view / projection** — drift and alert projections fold the event
  store into queryable read models (`getDrift` surfaces the drift projection).
- **Snapshot** — the accepted E2E record is the snapshot of those projections at
  evaluation time.
- **Read store** — MCP `get_drift` and CLI `hobo drift` query the drift read store
  rather than replaying raw provider state.

No runtime engine, projector, or event store is implemented here; this is a
design-time contract naming the command, event, actor, and projection boundaries
so later implementation inherits a consistent vocabulary.
