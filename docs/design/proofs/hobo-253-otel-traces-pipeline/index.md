# HOBO-253 OTEL Traces Pipeline Proof

This proof backs [PLAN-05](../../reliability-observability-cost.md#plan-05),
[ADR-0023](../../adr/02-identity-security.md#adr-0023), and
[ADR-0046](../../adr/02-identity-security.md#adr-0046).

Executable artifact:

- [`src/draft/technical-proofs/otel-traces-pipeline-contract`](../../../../src/draft/technical-proofs/otel-traces-pipeline-contract)

Acceptance evidence:

- A deploy exports one OTLP-shaped trace with nested deploy, step, actor, and provider spans.
- Provider-call spans include provider, region, and operation attributes.
- Collector failures are deferred with retry backoff and do not throw into run progress.
- Sampling drops spans at the configured rate while preserving child trace linkage.

Adversarial evidence:

- A bounded exporter buffer drops span floods without blocking producer operations.
- Provider SDK calls that swallow trace context are marked as `provider-context-lost`.
- Deep nesting is capped with an explicit `hobo.depth_exceeded` attribute.
- PII and secret attributes are redacted before spans reach the buffer or OTLP collector.

Scope boundary:

- No metrics pipeline, structured logs, OpenInference AI-method spans, or Run Inspector projection.
- No dashboard UI or provider-specific SDK adapter implementation.
- No real OTLP network client; the POC proves the exporter port against a mock collector.
