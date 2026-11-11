import { describe, expect, it } from "vitest";
import {
	CacheBindingError,
	createCacheCommandMeter,
	DEFAULT_MONTHLY_CACHE_COMMANDS,
	monthlyCommandAllowance,
	openCacheBackend,
	selectCacheBackend,
} from "../src/cache-backend.js";

const REST_URL = "https://relay-cache-12345.upstash.io";
const TOKEN = "AXyz-secret-token-value";
const VALKEY = "redis://:secret-password@valkey.internal:6379";

describe("choosing the relay's cache backend from the deployment's bindings", () => {
	it("takes the Upstash REST pair first, then Valkey, and says which by name", () => {
		const choice = selectCacheBackend({
			VERCEL_ENV: "production",
			KV_REST_API_URL: REST_URL,
			KV_REST_API_TOKEN: TOKEN,
			VALKEY_URL: VALKEY,
		});
		expect(choice).toEqual({
			kind: "upstash-rest",
			names: ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
			candidates: ["KV_REST_API_URL", "VALKEY_URL"],
		});
		// Upstash's own naming wins over the Vercel KV naming.
		expect(
			selectCacheBackend({
				UPSTASH_REDIS_REST_URL: REST_URL,
				UPSTASH_REDIS_REST_TOKEN: TOKEN,
				KV_REST_API_URL: REST_URL,
				KV_REST_API_TOKEN: TOKEN,
			}).names,
		).toEqual(["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]);
		// No values anywhere in what is logged.
		expect(JSON.stringify(choice)).not.toContain(TOKEN);
		expect(JSON.stringify(choice)).not.toContain("upstash.io");
	});

	it("binds Valkey, then Redis, over TCP when no REST pair is set", () => {
		expect(
			selectCacheBackend({ REDIS_URL: VALKEY, VALKEY_URL: VALKEY }),
		).toEqual({
			kind: "redis-protocol",
			names: ["VALKEY_URL"],
			candidates: ["VALKEY_URL", "REDIS_URL"],
		});
		expect(selectCacheBackend({ REDIS_URL: VALKEY }).names).toEqual([
			"REDIS_URL",
		]);
	});

	it("refuses a half-configured pair or a URL that is not Redis, naming the variable only", () => {
		const half = () => selectCacheBackend({ UPSTASH_REDIS_REST_URL: REST_URL });
		expect(half).toThrow(/UPSTASH_REDIS_REST_TOKEN/u);
		const wrong = () =>
			selectCacheBackend({ VALKEY_URL: "https://secret-password@host" });
		expect(wrong).toThrow(CacheBindingError);
		expect(wrong).toThrow(/VALKEY_URL/u);
		expect(wrong).not.toThrow(/secret-password/u);
	});

	it("uses the in-memory engine only off Vercel, and refuses a deployment with no cache", () => {
		expect(selectCacheBackend({}).kind).toBe("memory");
		expect(selectCacheBackend({ VERCEL_ENV: "development" }).kind).toBe(
			"memory",
		);
		for (const VERCEL_ENV of ["production", "preview"])
			expect(() => selectCacheBackend({ VERCEL_ENV })).toThrow(
				/no cache is bound/u,
			);
	});
});

describe("the cache's command meter", () => {
	it("adds each instance's commands to the month's counter and projects the month", async () => {
		const cache = await openCacheBackend(
			{ kind: "memory", names: [], candidates: [] },
			{},
		);
		const lines: unknown[] = [];
		// Ten days into a 30-day month.
		let now = Date.UTC(2026, 10, 11);
		const meter = createCacheCommandMeter({
			cache,
			environment: "test",
			allowance: 1000,
			now: () => now,
			log: (line) => lines.push(line),
		});
		for (let n = 0; n < 99; n += 1)
			await cache.state.get(
				(await import("@hobo/core")).parseEphemeralKey(`k:${n}`),
			);
		const first = await meter.flush();
		expect(first).toMatchObject({
			event: "hobo_ci_cache_commands",
			backend: "memory",
			month: "2026-11",
			used: 99,
			allowance: 1000,
		});
		expect(first?.projected).toBe(297);
		expect(first?.overBudget).toBe(false);
		expect(first?.byVerb).toEqual({ HMGET: 99 });
		// Within the interval nothing is sent; after it, the report's own
		// increment (a script load and its call, the first time) is counted.
		const byReport = cache.meter.usage().total - 99;
		expect(byReport).toBeGreaterThan(0);
		expect(await meter.maybeFlush()).toBeUndefined();
		now += 60_000;
		const second = await meter.maybeFlush();
		expect(second?.used).toBe(99 + byReport);
		expect(lines).toHaveLength(2);
	});

	it("reads the allowance by name, with the free tier as the default", () => {
		expect(monthlyCommandAllowance({})).toBe(DEFAULT_MONTHLY_CACHE_COMMANDS);
		expect(
			monthlyCommandAllowance({ HOBO_CI_CACHE_MONTHLY_COMMANDS: "2000000" }),
		).toBe(2_000_000);
		expect(() =>
			monthlyCommandAllowance({ HOBO_CI_CACHE_MONTHLY_COMMANDS: "lots" }),
		).toThrow(/HOBO_CI_CACHE_MONTHLY_COMMANDS/u);
	});
});
