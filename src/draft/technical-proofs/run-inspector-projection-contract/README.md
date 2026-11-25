# HOBO-264 Run Inspector Projection Contract

This POC pins the Run Inspector read-model contract as an independent branch
proof. It folds `run.*`, `actor.*`, and `saga.*` events into an inspectable run
timeline without building the dashboard, OTLP export, or production runtime.

## What It Proves

- A completed run renders step, saga, and actor timeline entries with attempts,
  duration, inputs, outputs, and memoized replay results.
- `atSeq` time travel reconstructs the historical view as of any event.
- Replay/diff flags unchanged outputs, changed non-deterministic outputs, and
  graceful step-signature mismatches.
- Causality links preserve `causationId`/`correlationId` ancestry.
- Large runs paginate step rows without losing total count.
- In-flight runs inspect honestly as partial instead of requiring completion.

## Scope Boundary

This package is a pure projection contract over fixture event envelopes. It does
not build the dashboard UI, OTLP traces, live Streamer integration, production
EventStore adapters, or the HOBO-115 CLI shell. HOBO-140 owns the earlier
`hobo inspect run|deploy|topology` CLI envelope; this proof owns the deeper Run
Inspector projection semantics.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\run-inspector-projection-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Run Inspector Projection Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
