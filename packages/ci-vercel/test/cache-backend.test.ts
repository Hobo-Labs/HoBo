import { parseEphemeralKey, parseEphemeralTtlMs } from "@hobo/core";
import { createMemoryBlobSdk } from "@hobo/provider-vercel-blob";
import { describe, expect, it } from "vitest";
import {
	CacheBindingError,
	cacheBindingEnv,
	DEFAULT_MONTHLY_CACHE_COMMANDS,
	discoverCacheBackends,
	monthlyCommandAllowance,
	openCacheBackend,
	openCacheBackends,
} from "../src/cache-backend.js";
import { defaultCacheOffers, parseCacheOffers } from "../src/cache-offers.js";

const REST_URL = "https://relay-cache-12345.upstash.io";
const TOKEN = "AXyz-secret-token-value";
const VALKEY = "redis://:secret-password@valkey.internal:6379";
const OTHER_REDIS = "rediss://:other-password@redis.internal:6380";
const TURSO_URL = "libsql://relay-cache-hobo.turso.io";
const TURSO_TOKEN = "turso-secret-token";

describe("the relay's cache backends, from the deployment's bindings", () => {
	it("makes every bound cache a member, in configured order, and says which by name", () => {
		const bindings = discoverCacheBackends({
			VERCEL_ENV: "production",
			KV_REST_API_URL: REST_URL,
			KV_REST_API_TOKEN: TOKEN,
			VALKEY_URL: VALKEY,
			REDIS_URL: OTHER_REDIS,
			TURSO_DATABASE_URL: TURSO_URL,
			TURSO_AUTH_TOKEN: TURSO_TOKEN,
			BLOB_STORE_ID: "store_abc123",
		});
		expect(bindings.members).toEqual([
			{
				id: "upstash",
				kind: "upstash-rest",
				names: ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
			},
			{ id: "valkey", kind: "redis-protocol", names: ["VALKEY_URL"] },
			{ id: "redis", kind: "redis-protocol", names: ["REDIS_URL"] },
			{
				id: "turso",
				kind: "libsql",
				names: ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"],
			},
			{ id: "blob", kind: "vercel-blob", names: ["BLOB_STORE_ID"] },
		]);
		// No values anywhere in what is logged.
		const logged = JSON.stringify(bindings);
		for (const secret of [TOKEN, "secret-password", TURSO_TOKEN, "upstash.io"])
			expect(logged).not.toContain(secret);
	});

	it("treats REDIS_URL equal to VALKEY_URL as one member", () => {
		expect(
			discoverCacheBackends({ REDIS_URL: VALKEY, VALKEY_URL: VALKEY }).members,
		).toEqual([
			{ id: "valkey", kind: "redis-protocol", names: ["VALKEY_URL"] },
		]);
		expect(discoverCacheBackends({ REDIS_URL: VALKEY }).members[0]?.id).toBe(
			"redis",
		);
	});

	it("refuses a half-configured pair or a URL that is not Redis, naming the variable only", () => {
		const half = () =>
			discoverCacheBackends({ UPSTASH_REDIS_REST_URL: REST_URL });
		expect(half).toThrow(/UPSTASH_REDIS_REST_TOKEN/u);
		const wrong = () =>
			discoverCacheBackends({ VALKEY_URL: "https://secret-password@host" });
		expect(wrong).toThrow(CacheBindingError);
		expect(wrong).toThrow(/VALKEY_URL/u);
		expect(wrong).not.toThrow(/secret-password/u);
		const turso = () =>
			discoverCacheBackends({ TURSO_DATABASE_URL: TURSO_URL });
		expect(turso).toThrow(/TURSO_AUTH_TOKEN/u);
		expect(turso).not.toThrow(/turso\.io/u);
	});

	it("uses the in-memory engine only off Vercel, and refuses a deployment with no cache", () => {
		expect(discoverCacheBackends({}).members).toEqual([
			{ id: "memory", kind: "memory", names: [] },
		]);
		for (const VERCEL_ENV of ["production", "preview"])
			expect(() => discoverCacheBackends({ VERCEL_ENV })).toThrow(
				/no cache is bound/u,
			);
	});

	it("takes cache bindings from the config service only for names the environment leaves unset", () => {
		const merged = cacheBindingEnv(
			{ VALKEY_URL: VALKEY, VERCEL_ENV: "production" },
			{ VALKEY_URL: OTHER_REDIS, TURSO_DATABASE_URL: TURSO_URL },
		);
		expect(merged.env.VALKEY_URL).toBe(VALKEY);
		expect(merged.env.TURSO_DATABASE_URL).toBe(TURSO_URL);
		expect(merged.fromConfig).toEqual(["TURSO_DATABASE_URL"]);
	});
});

describe("opening members, metered in the units each bills", () => {
	it("counts commands on a Redis-protocol member", async () => {
		const [memory] = await openCacheBackends(discoverCacheBackends({}), {});
		if (!memory) throw new Error("no member");
		await memory.state.get(parseEphemeralKey("k"));
		expect(memory.units).toEqual(["commands"]);
		expect(memory.usage()).toEqual({ commands: 1 });
	});

	it("counts simple and advanced operations on a Blob member, by the store id and OIDC alone", async () => {
		const binding = discoverCacheBackends({ BLOB_STORE_ID: "store_abc123" })
			.members[0];
		if (!binding) throw new Error("no member");
		const blob = await openCacheBackend(
			binding,
			{ BLOB_STORE_ID: "store_abc123" },
			{ blobSdk: createMemoryBlobSdk() },
		);
		const ttl = parseEphemeralTtlMs(60_000);
		await blob.state.putIfAbsent(parseEphemeralKey("k"), "v", ttl);
		await blob.state.get(parseEphemeralKey("k"));
		expect(blob.units).toEqual(["simple-operations", "advanced-operations"]);
		expect(blob.usage()).toEqual({
			"simple-operations": 1,
			"advanced-operations": 1,
		});
	});
});

describe("declared offers", () => {
	it("defaults to the vendor free tiers, with Blob pay-as-you-go and capped at nothing", () => {
		const offers = defaultCacheOffers();
		expect(offers.get("upstash")?.model.allowances).toEqual([
			{
				unit: "commands",
				included: 500_000,
				beyond: "hard-stop",
				meteredMicrosPerUnit: undefined,
			},
		]);
		expect(
			offers.get("turso")?.model.allowances.map((entry) => entry.included),
		).toEqual([500_000_000, 10_000_000]);
		expect(offers.get("valkey")?.model.allowances).toEqual([]);
		expect(offers.get("blob")).toMatchObject({
			tier: "payg",
			capMicros: undefined,
		});
		expect(offers.has("redis")).toBe(false);
	});

	it("replaces an offer and merges the marks from the declared document", () => {
		const parsed = parseCacheOffers(
			JSON.stringify({
				offers: [
					{
						backend: "upstash",
						tier: "payg",
						plan: "payg",
						fixedMonthlyFeeMicros: 0,
						capMicros: 5_000_000,
						allowances: [
							{
								unit: "commands",
								included: 0,
								beyond: "metered",
								meteredMicrosPerUnit: 2,
							},
						],
						evidence: { source: "owner", observedAt: "2026-11-11" },
					},
				],
				marks: { switchAtPercent: 85 },
			}),
		);
		expect(parsed.offers.get("upstash")).toMatchObject({
			tier: "payg",
			capMicros: 5_000_000,
		});
		expect(parsed.marks).toMatchObject({
			switchAt: 0.85,
			switchBackBelow: 0.8,
		});
	});

	it("names the key, never the document, when the offers do not parse", () => {
		for (const bad of [
			"{",
			JSON.stringify({ marks: { switchAtPercent: 70 } }),
			JSON.stringify({
				offers: [{ backend: "upstash", tier: "free", secret: "x" }],
			}),
		])
			expect(() => parseCacheOffers(bad)).toThrow(
				/^HOBO_CI_CACHE_OFFERS_JSON is not valid$/u,
			);
	});

	it("reads the Upstash allowance by name, with the free tier as the default", () => {
		expect(monthlyCommandAllowance({})).toBe(DEFAULT_MONTHLY_CACHE_COMMANDS);
		expect(
			monthlyCommandAllowance({ HOBO_CI_CACHE_MONTHLY_COMMANDS: "2000000" }),
		).toBe(2_000_000);
		expect(() =>
			monthlyCommandAllowance({ HOBO_CI_CACHE_MONTHLY_COMMANDS: "lots" }),
		).toThrow(/HOBO_CI_CACHE_MONTHLY_COMMANDS/u);
		expect(
			parseCacheOffers(undefined, 2_000_000).offers.get("upstash")?.model
				.allowances[0]?.included,
		).toBe(2_000_000);
	});
});
