# OpenInference Trajectory Capture Contract

Independent HOBO-335 POC for the `"use training"` runtime-capture boundary.

The contract models the data-plane side of training capture:

- each trainable-method invocation emits OpenInference-shaped span events;
- the same append-only log carries the assembled trajectory;
- a trajectory contains span tree, sanitized I/O, pending reward slot, run/agent correlation,
  retention policy, and sampling decision;
- candidate provenance records the exact trajectory ids consumed by a candidate;
- replay fails closed when span evidence exists without a matching trajectory append.

Scope kept out: optimizer consumption, live-eval reward attachment, OTLP export, and provider SDK
instrumentation.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\openinference-trajectory-capture-contract test
```

Design proof: [HOBO-335 OpenInference trajectory capture](../../../../docs/design/proofs/hobo-335-openinference-trajectory-capture/README.md).


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Openinference Trajectory Capture Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
