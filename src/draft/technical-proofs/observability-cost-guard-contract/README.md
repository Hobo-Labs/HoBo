# Observability Cost Guard Contract

Independent POC for HOBO-318. It pins the M3 guard against metric-cardinality explosion and observability-cost runaway without implementing the base metrics catalog, OTEL exporter, dashboard, or app-traffic degradation.

## Contract Surface

- `createObservabilityCostGuard({ catalog, tracePolicy, budget })` creates an in-memory guard over declared metric labels, trace sampling bounds, and observability export cost facts.
- `recordMetric(metric)` drops undeclared labels and buckets over-budget label values into `other`, keeping series cardinality bounded.
- `recordTraceSpan(span)` adaptively samples non-error trace floods while preserving error, SLO, and audit spans.
- `evaluateBudget()` enters telemetry-detail shedding when observability export cost burns budget.
- `snapshot()` exposes bounded series, trace sampling, recursive-telemetry suppression, and `observability-*` metering counters.

## Scope Boundaries

Included:

- Per-metric label allow-lists.
- Per-label cardinality budgets with aggregate-to-`other` overflow.
- Sampled exemplars for legitimate high-cardinality facts so they do not become labels.
- Error-biased adaptive trace sampling.
- Observability export bytes, trace spans, and metric series as metered cost dimensions.
- Budget response that sheds telemetry detail only.
- Recursive telemetry-about-telemetry suppression.

Excluded:

- Base metrics catalog and OTEL pipeline implementation.
- App request shedding or costAvailabilityProfile runtime degradation.
- Dashboard, alert routing, or provider-specific telemetry exporters.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\observability-cost-guard-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Observability Cost Guard Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
