# Runtime Port Conformance Contract

HOBO-30 proves the first `@hobo/conformance` durability slice for the
runtime-local backend. It exercises the local EventStore, Queue, Clock, and
ActorHost ports together without adding planner, provider, or production package
runtime code.

## Contract

`runRuntimePortDurabilitySuite(createBackend)` returns a frozen report with the
contract id `hobo.runtime-port-conformance/v1`, the backend name, per-check
results, failures, and local coverage totals.

The suite currently proves:

- EventStore optimistic concurrency rejects stale `expectedSeq` appends.
- EventStore idempotency keys dedupe retried appends.
- Queue idempotency keys dedupe retried enqueues.
- ActorHost fencing rejects stale lease appends.
- A checkout runtime proof replays to the same state as the live fold after
  EventStore, Queue, Clock, and ActorHost interactions.

## Negative Proof

`createBrokenFenceRuntimeBackend()` keeps the backend name `runtime-local` but
accepts stale ActorHost lease appends. The conformance report must fail
`actorHost.local.stale-fence-rejected`, proving the suite detects a backend that
claims local durability while dropping the fencing invariant.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\runtime-port-conformance-contract test
```

## Promotion note (S1-10 / HOBO-599)

Promoted to `packages/conformance/src/suites/runtime-port/` (production). Draft proof retained for historical evidence.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Runtime Port Conformance Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
