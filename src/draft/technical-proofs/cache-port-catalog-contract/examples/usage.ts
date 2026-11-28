import { strict as assert } from "node:assert";

import { cacheAside, MISS, SimCache, SimDurableKv } from "../src/cache-contract.ts";

let now = 0;
const clock = () => now;

const kv = new SimDurableKv<string>();
const cache = new SimCache<string>(clock);

kv.set("user:1", "Ada");
assert.equal(kv.get("user:1"), "Ada");
console.log("kv durable read:", kv.get("user:1"));

const first = cacheAside(cache, "user:1", () => kv.get("user:1"), 10);
console.log(`read#1 hit=${first.hit} value=${first.value}`);
const second = cacheAside(cache, "user:1", () => kv.get("user:1"), 10);
console.log(`read#2 hit=${second.hit} value=${second.value}`);

now += 11;
const afterTtl = cacheAside(cache, "user:1", () => kv.get("user:1"), 10);
console.log(`read#3 (post-TTL) hit=${afterTtl.hit} value=${afterTtl.value}`);

cache.evictAll();
const afterEvict = cacheAside(cache, "user:1", () => kv.get("user:1"), 10);
console.log(`read#4 (post-evict) hit=${afterEvict.hit} value=${afterEvict.value}`);

cache.evictAll();
assert.equal(cache.get("user:1"), MISS);
assert.equal(kv.get("user:1"), "Ada");
console.log("post-flush: cache=MISS kv=Ada");

assert.equal(cache.get("absent"), MISS);
console.log("cold key:", cache.get("absent") === MISS ? "MISS" : "ERR");

assert.ok(first.hit === false && second.hit === true, "cold then warm");
assert.ok(afterTtl.hit === false, "TTL evicts");
assert.ok(afterEvict.hit === false, "pressure evicts");
console.log(
	"CONTRACT HELD: cache is ephemeral/TTL/evictable; kv is durable/authoritative",
);
