/**
 * The retention table is the pack's honesty surface, so it gets tested directly
 * rather than only through the deployment path.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	isValkeyDurabilityMode,
	isValkeyEvictionPolicy,
	VALKEY_DURABILITY,
	VALKEY_DURABILITY_MODES,
	VALKEY_EVICTION,
	VALKEY_EVICTION_POLICIES,
	valkeyRetentionSemantics,
} from "../src/index.js";

describe("valkey durability semantics", () => {
	it("describes every mode, with no mode left to inference", () => {
		for (const mode of VALKEY_DURABILITY_MODES) {
			const semantics = VALKEY_DURABILITY[mode];
			assert.equal(semantics.mode, mode);
			assert.ok(semantics.note.length > 0);
		}
	});

	it("orders the modes by what a crash costs", () => {
		assert.equal(VALKEY_DURABILITY.none.worstCaseLossMs, null);
		assert.equal(VALKEY_DURABILITY["rdb-snapshots"].worstCaseLossMs, 60_000);
		assert.equal(VALKEY_DURABILITY["aof-everysec"].worstCaseLossMs, 1_000);
		assert.equal(VALKEY_DURABILITY["aof-always"].worstCaseLossMs, 0);
	});

	it("says which modes acknowledge a write before it is durable", () => {
		// This is the property that makes "we use Redis for durable state" wrong
		// most of the time, so it is stated per mode rather than implied.
		assert.equal(
			VALKEY_DURABILITY["aof-everysec"].acknowledgesBeforeDurable,
			true,
		);
		assert.equal(
			VALKEY_DURABILITY["aof-always"].acknowledgesBeforeDurable,
			false,
		);
	});

	it("only claims restart survival where the keyspace is written to the volume", () => {
		assert.equal(VALKEY_DURABILITY.none.survivesRestart, false);
		for (const mode of [
			"rdb-snapshots",
			"aof-everysec",
			"aof-always",
		] as const) {
			assert.equal(VALKEY_DURABILITY[mode].survivesRestart, true);
		}
	});
});

describe("valkey eviction semantics", () => {
	it("describes every policy", () => {
		for (const policy of VALKEY_EVICTION_POLICIES) {
			assert.equal(VALKEY_EVICTION[policy].policy, policy);
			assert.ok(VALKEY_EVICTION[policy].note.length > 0);
		}
	});

	it("marks exactly the allkeys policies as able to discard a key with no TTL", () => {
		for (const policy of VALKEY_EVICTION_POLICIES) {
			assert.equal(
				VALKEY_EVICTION[policy].evictsKeysWithoutTtl,
				policy.startsWith("allkeys-"),
				`${policy} classified wrongly`,
			);
		}
	});

	it("is the only policy that fails a write instead of dropping data", () => {
		assert.equal(VALKEY_EVICTION.noeviction.writeBehaviourAtLimit, "error");
		for (const policy of VALKEY_EVICTION_POLICIES.filter(
			(p) => p !== "noeviction",
		)) {
			assert.equal(
				VALKEY_EVICTION[policy].writeBehaviourAtLimit,
				"evict-then-accept",
			);
		}
	});
});

describe("valkeyRetentionSemantics", () => {
	it("calls a durable-and-retaining combination a durable keyspace", () => {
		const semantics = valkeyRetentionSemantics({
			durabilityMode: "aof-everysec",
			evictionPolicy: "noeviction",
		});
		assert.equal(semantics.behavesAsDurableKeyspace, true);
		assert.equal(semantics.keyLossPossible, false);
	});

	it("does not call a crash-durable cache a keyspace", () => {
		// The combination worth naming: no acknowledged write is lost to a crash,
		// and a key can still be evicted under memory pressure.
		const semantics = valkeyRetentionSemantics({
			durabilityMode: "aof-always",
			evictionPolicy: "allkeys-lru",
		});
		assert.equal(semantics.durability.worstCaseLossMs, 0);
		assert.equal(semantics.keyLossPossible, true);
		assert.equal(semantics.behavesAsDurableKeyspace, false);
	});

	it("reports key loss when nothing reaches the volume, whatever the eviction policy", () => {
		const semantics = valkeyRetentionSemantics({
			durabilityMode: "none",
			evictionPolicy: "noeviction",
		});
		assert.equal(semantics.keyLossPossible, true);
		assert.equal(semantics.behavesAsDurableKeyspace, false);
	});

	it("covers every mode/policy pair without throwing", () => {
		for (const durabilityMode of VALKEY_DURABILITY_MODES) {
			for (const evictionPolicy of VALKEY_EVICTION_POLICIES) {
				const semantics = valkeyRetentionSemantics({
					durabilityMode,
					evictionPolicy,
				});
				assert.equal(
					semantics.behavesAsDurableKeyspace,
					semantics.durability.survivesRestart &&
						!semantics.eviction.evictsKeysWithoutTtl,
				);
			}
		}
	});

	it("guards the two parse boundaries", () => {
		assert.ok(isValkeyDurabilityMode("aof-always"));
		assert.ok(!isValkeyDurabilityMode("aof-sometimes"));
		assert.ok(isValkeyEvictionPolicy("volatile-ttl"));
		assert.ok(!isValkeyEvictionPolicy("noeviction-ish"));
	});
});
