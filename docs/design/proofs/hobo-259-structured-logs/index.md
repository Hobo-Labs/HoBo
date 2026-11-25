# HOBO-259 Structured Logs Proof

This proof backs [PLAN-05](../../reliability-observability-cost.md#plan-05) and
[ADR-0023](../../adr/02-identity-security.md#adr-0023).

Executable artifact:

- [`src/draft/technical-proofs/structured-log-pipeline-contract`](../../../../src/draft/technical-proofs/structured-log-pipeline-contract)

Acceptance evidence:

- `ctx.log` emits structured records auto-tagged with `tenant`, `runId`, `resource`, and `traceId`.
- Live tail subscribers receive per-run log entries before the run is completed.
- Log `traceId` is parsed from and matches the enclosing W3C `traceparent`.
- Historical export writes the same redacted records through a configured sink port.
- Level filtering drops below-threshold records before they reach live tail or export.

Adversarial evidence:

- Hot-loop floods are rate-limited and reported as drops without throwing or blocking run progress.
- Secret fields such as tokens and passwords are redacted before live tail and historical export.
- Tail subscriber disconnects skip that subscriber while healthy subscribers keep receiving entries.
- Concurrent producers in one run receive monotonically increasing per-run sequence numbers.

Scope boundary:

- No dashboard log view UI.
- No metrics, trace exporter, or OpenInference payload work.
- No provider-specific OTLP, file, or object-store backend; the POC proves the historical sink port.
