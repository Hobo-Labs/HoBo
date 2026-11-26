# Projection Consistency + Reactivity Contract POC

This draft package proves HOBO-53: projection contracts carry a tunable consistency level and a reactivity class, with `session` as the default.

## Contract

- `declareProjection(...)` emits a `projection.Declared` event payload containing the read-model record, read-set, reactivity class, sink metadata, and consistency level.
- `reactive` is true only for the native log-backed sink or sinks that advertise `change-feed`.
- Non-reactive sinks stay usable for snapshot/query reads, but `doctorUseQuery(...)` emits a warning for live `"use query"` use.
- `strong` cross-Camp consistency is preserved and flagged as a cost/latency tradeoff; it is never silently downgraded.

## Proof

- `npm.cmd --prefix src\draft\technical-proofs\projection-consistency-reactivity-contract test`
- The runtime tests cover the acceptance bullets and adversarial warnings.
- `type-fixtures/type-contract.fixture.ts` is compiled by the test suite using TypeScript to prove non-change-feed projections statically expose `reactive: false`.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Projection Consistency Reactivity Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
