# HOBO-257 Metrics Catalog Pipeline Proof

This proof backs [PLAN-05](../../reliability-observability-cost.md#plan-05) and
[ADR-0046](../../adr/02-identity-security.md#adr-0046).

Executable artifact:

- [`src/draft/technical-proofs/metrics-catalog-pipeline-contract`](../../../../src/draft/technical-proofs/metrics-catalog-pipeline-contract)

Acceptance evidence:

- Deploy lifecycle emission increments control.deploy.success.total and records
  control.deploy.plan_to_deployed.duration_ms.
- Provider errors are keyed by provider, region, and operation.
- Data-plane RED metrics appear for service requests.
- Wasm runtime metrics cover cold start, instance density, link-call latency, and link-call errors.
- Mock OTLP export preserves metric names, units, labels, temporality, counters, gauges, and histograms.
- Every metric has a declared bounded label schema.

Adversarial evidence:

- Unknown or unbounded labels fail closed before export.
- Raw user routes are bucketed to __untemplated__ unless a route template is provided.
- Restarted actor-local counter samples are converted to monotonic deltas.
- Mis-sized histogram buckets fail catalog validation.
- Metrics emitted without declared labels are rejected.

Scope boundary:

- No SLO burn-rate computation, alert routing, or AI-method metric semantics.
- No real OTLP transport; the POC proves the exporter port against a mock collector.
- No cardinality-explosion runtime policy beyond the bounded-label contract asserted here.
