# HOBO-20 Camp EventStore Runtime Proof

This proof backs [PLAN-11](../../data-plane.md#plan-11),
[PLAN-20](../../wasm-runtime-wit.md#plan-20), [PLAN-32](../../data-plane.md#plan-32),
[ADR-0002](../../adr/01-architecture-core.md#adr-0002),
[ADR-0003](../../adr/01-architecture-core.md#adr-0003),
[ADR-0040](../../adr/01-architecture-core.md#adr-0040), and
[ADR-0050](../../adr/03-data-plane.md#adr-0050).

The executable POC in
[`src/draft/technical-proofs/camp-eventstore-runtime-port-contract`](../../../../src/draft/technical-proofs/camp-eventstore-runtime-port-contract)
pins the HOBO-20 runtime-local EventStore boundary.

**Promoted to production:** [`packages/runtimes/runtime-local`](../../../../packages/runtimes/runtime-local)
(S1-05 / HOBO-594) — SQLite-backed `createRuntimeLocalEventStore` with durability
assertions. The `@hobo/conformance` EventStore suite runs from
[`packages/conformance/test/runtime-local-eventstore.conformance.test.ts`](../../../../packages/conformance/test/runtime-local-eventstore.conformance.test.ts)
(adapter boundary lint forbids `@hobo/conformance` imports inside runtime-local).
The promoted runtime uses Node's built-in `node:sqlite` adapter, so
`@hobo/runtime-local` keeps Node 24+ type support with the package. Pact replay
fixtures remain package-local under `packages/runtimes/runtime-local/contracts/`.

The draft POC still pins the HOBO-20 runtime-local EventStore boundary:

- `append/read/subscribe/snapshot` operate over an append-only per-stream log;
- `EventEnvelope` carries per-stream `seq`, runtime-clock timestamp, actor,
  tenant, causation/correlation, data, and metadata;
- stale `expectedSeq` appends fail before mutating the stream;
- duplicate `meta.idempotencyKey` retries dedup to the original event without
  appending a second fact;
- idempotency keys are scoped per stream, so identical keys in different streams
  do not collide;
- malformed event bodies quarantine as `*.Quarantined` audit facts and folds
  continue deterministically;
- `runEventStoreConformance()` reports the runtime-local subset as machine-readable
  conformance evidence.

Scope kept out: provider-backed runtime stores, Reactor/projection delivery,
cross-Camp replication, and ActorHost/CQRS ergonomics.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\camp-eventstore-runtime-port-contract test
```
