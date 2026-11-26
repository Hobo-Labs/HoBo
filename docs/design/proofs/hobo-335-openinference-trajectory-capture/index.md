# HOBO-335 OpenInference Trajectory Capture Proof

This proof backs [PLAN-05](../../reliability-observability-cost.md#plan-05),
[PLAN-12](../../security-networking.md#plan-12), [PLAN-23](../../generated-stack.md#plan-23),
[ADR-0023](../../adr/02-identity-security.md#adr-0023), and
[ADR-0025](../../adr/03-data-plane.md#adr-0025).

The executable POC in
[`src/draft/technical-proofs/openinference-trajectory-capture-contract`](../../../../src/draft/technical-proofs/openinference-trajectory-capture-contract)
proves the M1 OpenInference trajectory-capture skeleton:

- a fixture `"use training"` invocation emits OpenInference `CHAIN`/`LLM` span events and appends a
  `training.TrajectoryCaptured` event to the log;
- replay reconstructs the same canonical trajectory from the log;
- candidate provenance recovers the exact trajectory ids and hashes that fed the candidate;
- sensitive fields are encrypted by per-run reference at capture, never logged as cleartext, and
  carry trace/trajectory retention policy;
- sampling drops are explicit `training.TrajectorySampledOut` audit events;
- replay fails closed when span evidence exists but the trajectory append is missing;
- shuffled event order reconstructs the same canonical trajectory.

Scope kept out: optimizer execution, live-eval reward attachment, OTLP exporter wiring, and concrete
provider instrumentation.
