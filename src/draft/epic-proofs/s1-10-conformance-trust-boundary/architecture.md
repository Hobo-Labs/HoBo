# S1-10 conformance trust boundary architecture

Event-sourced checkout proof appends domain events through EventStore,
ActorHost lease fencing, Queue idempotency, and Clock durable timers.
Actors emit events; read models are folded projections — never mutated in place.

Parse-don't-validate: `parseRuntimePortReport` and `parseComponentHostManifest`
are the only raw-input boundaries into refined report/manifest types.

Materialized views are derived by folding the append-only event log; replay
must equal live fold state (`runtime.local.checkout-replay-equals-live`).

PACT boundaries: suite ↔ runtime backend, suite ↔ component-host adapter.
