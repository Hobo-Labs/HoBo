# Replay/Live Equivalence POC

Independent POC for HOBO-60. It pins the spike decision and reusable assertion surface for the Reactor, snapshot, and rebuild slices that consume the replay/live guarantee.

## Contract Surface

- `assertReplayEqualsLive(...)`: runs a materialization through a live interleaving and through replay at the same per-stream seq vector, then compares normalized outputs.
- `seqVector(events)`: computes the per-stream position vector used for multi-stream materializations.
- `hashReadSet(events)`: stable read-set hash over the materialization's subscribed streams.
- `interleaveStreams(...)`: deterministic fuzz helper that preserves per-stream seq order while varying cross-stream arrival order.
- `ReplayLiveMismatchError`: carries live/replay state and event orders for downstream conformance diagnostics.

## Decision Summary

- Replay/live equality is a conformance helper, not the Reactor implementation.
- Multi-stream snapshots compare at a per-stream seq vector, not a single global seq.
- Folds and upcasters must be pure and read-only. Ambient `Date.now`, `Math.random`, environment, IO, `step`, and writes are outside the deterministic fold boundary.
- Runtime-provided clock/random are allowed only through the seeded materialization context.
- Cross-stream order dependence and floating-point accumulation order drift are test failures unless the materialization defines an exact, canonical accumulator.
- Upcasters are invoked before folding in both live and replay paths; impure upcasters fail the same gate as impure folds.

## Scope Boundaries

This POC does not implement the Reactor, Streamer transport, snapshot store, cross-Camp subscriptions, RX operators, sink adapters, or poison-event quarantine. It defines the proof primitive those later slices import.

## Promotion

S1-12 (HOBO-601) promotes this spike to production at `@hobo/runtime/replay`. Draft POC ahead of merge: `src/draft/technical-proofs/deterministic-replay-engine/`.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\replay-live-equivalence-poc test
npm.cmd test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Replay Live Equivalence Poc.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
