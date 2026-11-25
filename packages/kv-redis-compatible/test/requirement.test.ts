import { parseProfileId } from "@hobo/capability-profiles";
import { describe, expect, it } from "vitest";

import {
	KV_EPHEMERAL_STATE_PROFILE,
	KV_REDIS_COMPATIBLE_PROFILE,
	KV_VALKEY_PROFILE,
	KvRedisCompatibleError,
	redisCompatible,
	valkey,
} from "../src/index.js";

describe("redisCompatible.store", () => {
	it("asks for the profile and nothing about a provider", () => {
		const requirement = redisCompatible.store();
		expect(requirement.requiredProfiles).toEqual([
			{ profileId: KV_REDIS_COMPATIBLE_PROFILE, versionRange: ">=1" },
		]);
		const serialized = JSON.stringify(requirement);
		for (const productName of [
			"upstash",
			"redis-cloud",
			"valkey",
			"aws",
			"provider",
		]) {
			expect(serialized.toLowerCase()).not.toContain(productName);
		}
	});

	it("always demands Redis command semantics, not merely a key/value shape", () => {
		expect(redisCompatible.store().guarantees).toEqual([
			{ key: "redisCommandSemantics", operator: "equals", value: true },
		]);
	});

	it("emits a required feature only for the capabilities the author asked for", () => {
		const requirement = redisCompatible.store({
			ttl: true,
			atomicIncrement: true,
		});
		expect(requirement.features.map((feature) => feature.key)).toEqual([
			"atomicIncrement",
			"ttl",
		]);
		expect(
			requirement.features.every((feature) => feature.necessity === "required"),
		).toBe(true);
	});

	it("treats an explicit false as 'do not care', never as a prohibition", () => {
		// A prohibition would rule out a store that happens to support TTL,
		// which is not what an author who wrote `ttl: false` means.
		expect(redisCompatible.store({ ttl: false }).features).toEqual([]);
	});

	it("turns a minimum value size into an at-least gate", () => {
		const requirement = redisCompatible.store({ minValueBytes: 65_536 });
		expect(requirement.features).toEqual([
			{
				key: "maxValueBytes",
				operator: "at-least",
				value: 65_536,
				necessity: "required",
			},
		]);
	});

	it("rejects a nonsensical value size at the authoring boundary", () => {
		expect(() => redisCompatible.store({ minValueBytes: 0 })).toThrow(
			KvRedisCompatibleError,
		);
		expect(() => redisCompatible.store({ minValueBytes: 1.5 })).toThrow(
			/positive integer/u,
		);
	});

	it("carries runtime and realization constraints through", () => {
		const requirement = redisCompatible.store({
			runtime: { allowed: ["wasm", "serverless_faas"] },
			realization: { allowBridge: false },
		});
		expect(requirement.runtime.allowed).toEqual(["wasm", "serverless_faas"]);
		expect(requirement.realization.bridge).toBe(false);
	});

	it("is order-independent: the same ask parses to the same requirement", () => {
		expect(redisCompatible.store({ ttl: true, sortedSets: true })).toEqual(
			redisCompatible.store({ sortedSets: true, ttl: true }),
		);
	});
});

describe("valkey.store", () => {
	it("asks for the Valkey refinement of the Redis-compatible profile", () => {
		expect(valkey.store().requiredProfiles).toEqual([
			{ profileId: KV_VALKEY_PROFILE, versionRange: ">=1" },
		]);
	});

	it("shares the Redis feature vocabulary", () => {
		expect(valkey.store({ atomicCompareAndSet: true }).features).toEqual([
			{
				key: "atomicCompareAndSet",
				operator: "equals",
				value: true,
				necessity: "required",
			},
		]);
	});
});

describe("the ephemeral-state profile", () => {
	it("is a canonical kv profile id the registry can resolve", () => {
		expect(parseProfileId(KV_EPHEMERAL_STATE_PROFILE)).toMatchObject({
			primitive: "kv",
			path: ["kv", "ephemeral-state"],
			major: 1,
		});
	});
});
