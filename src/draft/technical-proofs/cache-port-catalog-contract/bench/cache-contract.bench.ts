import { bench, describe } from "vitest";

import { cacheAside, SimCache, SimDurableKv } from "../src/cache-contract.ts";

// Numbers are advisory; the gate only requires that declared benches EXECUTE.
describe("cache-port hot path", () => {
	let now = 0;
	const clock = () => now;
	const kv = new SimDurableKv<string>();
	const cache = new SimCache<string>(clock);
	kv.set("user:1", "Ada");

	bench("cache-aside read (warm)", () => {
		cacheAside(cache, "user:1", () => kv.get("user:1"), 10_000);
	});

	bench("cache set + get", () => {
		cache.set("k", "v", 10_000);
		cache.get("k");
	});
});
