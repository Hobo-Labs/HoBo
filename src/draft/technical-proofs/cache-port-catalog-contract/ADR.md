# ADR: Cache port (`hobo:cache`) vs durable `kv` — catalog contract

## Status
Accepted — pins design [ADR-0118](../../../../docs/design/adr/03-data-plane.md#adr-0118).

## Context
The resource catalog folded caching into `kv`/`data` ("data/caching (`data`/`kv`)"), but
`kv` maps to durable stores (DynamoDB/Cosmos/Firestore) that are a source of truth with no
TTL or eviction contract. Every mainstream PaaS in the 2026-07-03 competitor expansion
exposes an ephemeral cache as a *separate* primitive. This proof makes the two contracts
executable so the distinction cannot silently regress into an overclaim.

## Decision
The proof pins the observable contract of the two ports:

- **`hobo:cache` (`SimCache`)** — `set(key, value, ttl)`, `get(key) → value | MISS`,
  `delete`, `evictAll` (memory-pressure eviction). A key is a **MISS** when cold, expired,
  or evicted — **never an error**. TTL is enforced against a deterministic logical clock.
- **`hobo:kv` (`SimDurableKv`)** — `set`/`get`/`delete`, **authoritative**, no TTL, no
  eviction.
- **`cacheAside`** — read from cache; on MISS recompute from the durable source and
  populate. **Correctness never depends on a hit**: after TTL expiry, eviction, or a full
  flush, the read still returns the authoritative value by recomputation.

Parse, don't validate: the CUE constraints (`cue/cache.cue`) turn the protobuf shapes
(`proto/cache.proto`) into **derived types** — a value is either a valid `#CacheEntry` or it
does not exist — and the `MISS` sentinel (a unique `symbol`) makes a cache miss
unrepresentable as a value, so callers must handle it explicitly.

### Event architecture
The cache is deliberately *not* event-sourced (it is ephemeral), but it composes with the
event-sourced data plane rather than bypassing it:
- **Command:** `CacheSetCommand` / `CacheInvalidateCommand` carry the app's write intent.
- **Event:** tag invalidation rides existing `data.*` **events** — no new event family.
- **Actor:** the owning aggregate (an **actor**'s single-writer lease, ADR-0053) is what emits an invalidation on write.
- **Event store:** the invalidation subscription consumes the authoritative **event store** / reactor log (ADR-0050).
- **Materialized view / projection:** a cache entry is a disposable **projection** of the source of truth — never authoritative.
- **Snapshot:** each entry is an ephemeral, TTL-bounded **snapshot** of a computed value.
- **Read store:** the cache is a **read store** in front of the durable read model (cache-aside).

A PACT boundary contract (`contracts/cache.pact.json`) pins the get-miss / set-hit /
post-TTL-miss / invalidate interactions.

## Consequences
Downstream layers must treat `cache` and `kv` as non-interchangeable ports: a cache MAY be
cold at any time and MUST NOT be relied on for durability, while a durable `kv` MUST NOT be
assumed to expire or evict. Performance is advisory (`bench/`); the semantic contract, not
throughput, is what this proof gates.
