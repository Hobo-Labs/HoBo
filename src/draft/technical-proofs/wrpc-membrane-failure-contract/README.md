# wRPC Membrane Failure Contract POC

Independent POC for HOBO-25. It pins the membrane behavior that was explicitly out of scope for HOBO-18: bounded backpressure, partial/ambiguous failure signals, and the reconciliation rule that separates HoBo-owned EventStore effects from provider RPC effects.

## Contract Surface

- `createMembraneFailureContract()` registers WIT-provider exports with a bounded `maxInFlight` counter.
- `MembraneOverloadedError` maps saturated providers to `membrane: "overloaded"` and the system `transient` strategy.
- `MembraneSeveredError` and `AmbiguousReturnError` map mid-stream severance / ambiguous return to `partial-failure` with `forward-key-or-refresh-before-act`.
- `reconcileAmbiguousFailure(...)`:
  - dedups EventStore append effects through `meta.idempotencyKey`;
  - retries provider RPC at least once while forwarding the idempotency key;
  - suppresses retry storms while the provider remains overloaded.
- `runMembraneFailureConformance()` emits the HOBO-25 component-host conformance assertions.

## Scope Boundaries

This POC does not implement NATS/JetStream, per-provider idempotency mechanisms, or Reactor client coalescing. It proves the contract a real membrane/host adapter must satisfy.

**S1-09 promotion:** integrated with HOBO-24 in `src/draft/technical-proofs/membrane-deadline-backpressure-contract/` (HOBO-598). Production target: `packages/runtimes/runtime-local/src/membrane/backpressure.ts` + `packages/conformance/src/membrane/membrane-failure-lane.ts`.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\wrpc-membrane-failure-contract test
npm.cmd test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Wrpc Membrane Failure Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
