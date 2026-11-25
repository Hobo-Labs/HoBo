# HOBO-318 Observability Cost Guard Proof

This proof backs [PLAN-05](../../reliability-observability-cost.md#plan-05) and [ADR-0039](../../adr/02-identity-security.md#adr-0039).

Executable artifact:

- [`src/draft/technical-proofs/observability-cost-guard-contract`](../../../../src/draft/technical-proofs/observability-cost-guard-contract)

Acceptance evidence:

- High-cardinality user labels are dropped or bucketed so metric series count stays bounded.
- Legitimate high-cardinality facts remain sampled exemplars rather than series labels.
- Trace floods are adaptively sampled while error traces remain exported.
- Observability export bytes, exported trace spans, and metric series appear as first-class metered cost dimensions.
- Observability-budget burn returns a telemetry-detail shedding obligation and leaves app traffic unaffected.

Adversarial evidence:

- An attacker driving unique label values cannot create unbounded series.
- The guard remembers only the declared label budget, avoiding unbounded label-memory growth.
- Sampling does not drop the one error trace that mattered.
- Budget shedding drops low-priority telemetry detail, not application requests.
- Guard telemetry is suppressed from recursive metering.

Scope boundary:

- No base metrics catalog, OTEL pipeline, dashboard, alert routing, or provider-specific telemetry exporter.
- No app-traffic shedding or runtime `costAvailabilityProfile` degradation.
