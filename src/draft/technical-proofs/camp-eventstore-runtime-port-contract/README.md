# Camp EventStore Runtime Port Contract POC

Independent POC for HOBO-20, pinning the `EventStore` runtime port for the
runtime-local Camp backend.

## Contract Surface

- `createRuntimeLocalEventStore({ clock })` exposes `append`, `read`,
  `subscribe`, `snapshot`, and `fold`.
- `append(streamId, events, { expectedSeq })` enforces per-stream optimistic
  concurrency.
- `EventEnvelope` records per-stream `seq`, deterministic runtime-clock `ts`,
  actor, tenant, causation/correlation ids, typed data, and metadata.
- `meta.idempotencyKey` dedups retried appends for exactly-once effects, scoped
  per stream.
- `fold(streamId, { initialState, handlers })` quarantines poison events with an
  auditable `*.Quarantined` fact and skips them deterministically on replay.
- `runEventStoreConformance()` returns a machine-readable conformance report for
  the runtime-local subset.

## Scope Boundaries

Included:

- Runtime-local append/read/subscribe/snapshot behavior.
- Seq-conditional append and stale writer rejection.
- Idempotency-key dedup and collision scoping per stream.
- Poison-event quarantine and deterministic fold continuation.
- A reusable conformance report for the EventStore subset.

Excluded:

- Postgres, Temporal, Restate, Cloudflare, or other provider-backed runtime
  backends.
- Projections/Reactor delivery beyond the local subscription callback.
- Cross-Camp replication.
- ActorHost lease and CQRS command ergonomics, covered by adjacent POCs.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\camp-eventstore-runtime-port-contract test
npm.cmd test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Camp Eventstore Runtime Port Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
