/**
 * Runnable example for cache-port-catalog-contract. The draft-artifact gate EXECUTES this
 * with `node --import tsx` and diffs stdout against usage.expected.txt — keep both honest.
 *
 * Proves ADR-0118: `hobo:cache` (ephemeral / TTL / evictable / never-authoritative) is a
 * distinct contract from `hobo:kv` (durable / authoritative). Deterministic logical clock.
 */
import { strict as assert } from "node:assert";

import { cacheAside, MISS, SimCache, SimDurableKv } from "../src/cache-contract.ts";

let now = 0;
const clock = () => now;

const kv = new SimDurableKv<string>(); // source of truth
const cache = new SimCache<string>(clock); // ephemeral layer

// 1) Durable kv is authoritative.
kv.set("user:1", "Ada");
assert.equal(kv.get("user:1"), "Ada");
console.log("kv durable read:", kv.get("user:1"));

// 2) Cache-aside: cold miss recomputes from kv, then hits.
const first = cacheAside(cache, "user:1", () => kv.get("user:1"), 10);
console.log(`read#1 hit=${first.hit} value=${first.value}`);
const second = cacheAside(cache, "user:1", () => kv.get("user:1"), 10);
console.log(`read#2 hit=${second.hit} value=${second.value}`);

// 3) TTL expiry -> miss -> recompute (correctness preserved).
now += 11; // advance past ttl
const afterTtl = cacheAside(cache, "user:1", () => kv.get("user:1"), 10);
console.log(`read#3 (post-TTL) hit=${afterTtl.hit} value=${afterTtl.value}`);

// 4) Memory-pressure eviction -> miss -> recompute.
cache.evictAll();
const afterEvict = cacheAside(cache, "user:1", () => kv.get("user:1"), 10);
console.log(`read#4 (post-evict) hit=${afterEvict.hit} value=${afterEvict.value}`);

// 5) Cache is never the source of truth: flush cache, kv stays authoritative.
cache.evictAll();
assert.equal(cache.get("user:1"), MISS);
assert.equal(kv.get("user:1"), "Ada");
console.log("post-flush: cache=MISS kv=Ada");

// 6) A cold key is a MISS, never an error.
assert.equal(cache.get("absent"), MISS);
console.log("cold key:", cache.get("absent") === MISS ? "MISS" : "ERR");

// Contract summary — the two ports are not interchangeable.
assert.ok(first.hit === false && second.hit === true, "cold then warm");
assert.ok(afterTtl.hit === false, "TTL evicts");
assert.ok(afterEvict.hit === false, "pressure evicts");
console.log(
	"CONTRACT HELD: cache is ephemeral/TTL/evictable; kv is durable/authoritative",
);
