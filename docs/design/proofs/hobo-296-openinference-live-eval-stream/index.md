# HOBO-296 OpenInference Live Eval Stream Proof

This proof backs [PLAN-05](../../reliability-observability-cost.md#plan-05),
[PLAN-23](../../generated-stack.md#plan-23), [ADR-0025](../../adr/03-data-plane.md#adr-0025),
[ADR-0046](../../adr/02-identity-security.md#adr-0046), and
[ADR-0055](../../adr/03-data-plane.md#adr-0055).

Executable artifact:

- [`src/draft/technical-proofs/openinference-live-eval-stream-contract`](../../../../src/draft/technical-proofs/openinference-live-eval-stream-contract)

Acceptance evidence:

- A trainable-method call emits OpenInference spans nested under the enclosing run trace with model,
  token, latency, method, candidate, and cost-counted attributes.
- The trajectory assembles span tree, sanitized I/O, reward state, and run/agent/trace correlation.
- Live-eval rubric scores are metrics and `eval.Ran` events.
- Failed live evals emit `eval.GateFailed`, `slo.BudgetBurned`, and `resource.DriftDetected`.
- A mock OpenInference-compatible backend accepts the combined span, trajectory, metric, and event
  export payload.

Adversarial evidence:

- Sensitive payload fields are replaced by per-run encrypted references before telemetry export.
- Large message payloads are offloaded by digest/ref instead of being inlined into spans/events/export.
- Eval errors return the original request response and mark the trajectory reward incomplete.
- Missing rewards are incomplete and produce no `eval.score` metric.
- Shadow calls export telemetry but do not add to billable token cost.

Scope boundary:

- No optimizer, trainer, or model-update execution.
- No concrete encryption provider or key lifecycle implementation beyond the capture hook contract.
- No champion/challenger promotion decision logic; this proof only emits the telemetry facts consumed
  by that gate.
