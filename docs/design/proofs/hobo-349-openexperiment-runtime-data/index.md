# HOBO-349 OpenExperiment Runtime Data Proof

This proof connects the runtime data-collection half of OpenExperiment to:

- [contracts-policy-flags.md](../../contracts-policy-flags.md#plan-29)
- [reliability-observability-cost.md](../../reliability-observability-cost.md#plan-05)
- [docs/standards/openfeature.md](../../../standards/openfeature.md)
- [ADR-0046](../../adr/02-identity-security.md#adr-0046)
- [ADR-0083](../../adr/02-identity-security.md#adr-0083)

Executable artifact:

- [`src/draft/technical-proofs/openexperiment-runtime-data-contract`](../../../../src/draft/technical-proofs/openexperiment-runtime-data-contract)

Acceptance evidence:

- Assignment uses stable flag-style bucketing over `(experiment flag, subject)`
  and is deterministic for fixed experiment and subject input.
- First assignment is pinned for the experiment lifetime, so later allocation
  changes do not silently re-bucket an already assigned subject.
- `experiment.Assigned` and `experiment.Exposed` records carry explicit sampled
  population markers.
- Exposure is emitted only when the assigned variant affects behavior.
- Exposure is idempotent by `(experiment, subject)`.
- Exposure metric references carry both event-log id and W3C trace id/span id
  joins for OTEL-backed ingestion.
- Sampled exposure streams are rejected when a downstream reader asks for full
  traffic.

Scope boundary:

- No `experiment.Concluded` or statistical-analysis surface.
- No peeking, p-hacking, or under-power guardrails.
- No provider adapters.
- No eval/training-engine loop.
