# HOBO-264 Run Inspector Projection Proof

This proof backs [PLAN-05](../../reliability-observability-cost.md#plan-05).

The executable POC in
[`src/draft/technical-proofs/run-inspector-projection-contract`](../../../../src/draft/technical-proofs/run-inspector-projection-contract)
pins the Run Inspector projection contract:

- completed `run.*` / `actor.*` / `saga.*` event streams render a step/saga/actor timeline with
  inputs, outputs, attempts, durations, and memoized replay results;
- `atSeq` time travel reconstructs historical state;
- replay/diff flags unchanged, changed, and step-signature-mismatch outcomes without crashing;
- `causationId` / `correlationId` links provide event ancestry;
- thousand-step runs are paginated, while in-flight runs remain inspectable as partial.

Scope kept out: dashboard UI, OTLP traces, live Streamer integration, production EventStore
adapters, and the HOBO-115 CLI shell.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\run-inspector-projection-contract test
```
