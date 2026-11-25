# HOBO-241 Trace Context Propagation Proof

This proof backs [PLAN-05](../../reliability-observability-cost.md#plan-05) and
[PLAN-11](../../data-plane.md#plan-11).

The executable POC in
[`src/draft/technical-proofs/trace-context-propagation-contract`](../../../../src/draft/technical-proofs/trace-context-propagation-contract)
proves the M1 trace-context skeleton:

- ingress without `meta.traceparent` synthesizes a W3C root traceparent;
- command to span to child-command propagation keeps one trace and preserves causation/correlation;
- fan-out sibling spans share a parent span;
- queued commands retain trace context across async hops;
- malformed traceparents are regenerated instead of trusted;
- child spans are monotonic even when the clock reports skew.

Scope kept out: OTLP export, metrics, log correlation beyond trace id tagging, and provider SDK
instrumentation.
