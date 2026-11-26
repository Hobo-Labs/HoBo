# Trace Context Propagation Contract

Independent POC for HOBO-241. It pins the M1 trace-context skeleton without adding OTLP export,
metrics, logs, or provider instrumentation.

The contract proves:

- `meta.traceparent` is present and W3C-shaped at ingress.
- Commands, events, child commands, and queue hops preserve one trace.
- `withSpan()` records step/actor span metadata with causation and correlation links.
- Malformed or missing traceparents fail closed by regeneration with an explicit repair marker.
- Fan-out sibling spans keep the same parent, and clock skew cannot create negative spans.

Run:

```sh
npm.cmd --prefix src/draft/technical-proofs/trace-context-propagation-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Trace Context Propagation Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
