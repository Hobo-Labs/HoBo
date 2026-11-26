# OpenInference Live Eval Stream Contract

Independent HOBO-296 POC for the M2 AI-method telemetry and live-eval stream boundary.

The contract models one trainable-method invocation after the lower-level OTEL trace and trajectory
capture primitives exist:

- the trainable method emits OpenInference `CHAIN`/child spans as children of the enclosing run
  trace;
- the trajectory records span tree, sanitized I/O, reward status, and run/agent correlation;
- live-eval rubric scores become first-class metrics and `eval.Ran` events;
- a failed live eval emits `eval.GateFailed` plus SLO burn and drift signals;
- a mock OpenInference-compatible backend receives spans, trajectories, metrics, and events in one
  export payload.

Adversarial guards are executable: sensitive fields require per-run encrypted references, large
payloads are offloaded before telemetry export, eval errors do not block the request, missing rewards
remain explicitly incomplete, and shadow calls are excluded from billable cost accounting.

Scope kept out: optimizer/training execution, per-run encryption mechanics beyond the telemetry hook,
and champion/challenger promotion-gate logic.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\openinference-live-eval-stream-contract test
```

Design proof: [HOBO-296 OpenInference live eval stream](../../../../docs/design/proofs/hobo-296-openinference-live-eval-stream/README.md).


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Openinference Live Eval Stream Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
