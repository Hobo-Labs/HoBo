/**
 * Selection behaviour, including the rejection this pack exists to guarantee.
 *
 * A Redis-compatible store is the single most common place a capability model
 * quietly over-claims: `LPUSH`/`BRPOP` looks like a work queue and streams look
 * like a durable log, so a candidate that advertised `queue.*` would win those
 * selections and then lose messages on a restart, a failover, or a consumer crash.
 * The `PROFILE_INCOMPATIBLE` cases below are the guardrail.
 */
import assert from "node:assert/strict";
import {
	createCapabilityProfileRegistry,
	DEFAULT_TRUST_POLICY,
	parseCapabilityRequirement,
	STANDARD_CAPABILITY_PROFILES,
	selectCapabilityImplementation,
} from "@hobo/capability-profiles";
import { describe, it } from "vitest";

import {
	VALKEY_PACK_DEFINITION_ID,
	valkeyPackCandidate,
} from "../src/index.js";
import { verifiedValkeyPack } from "./harness.js";

const registry = createCapabilityProfileRegistry(STANDARD_CAPABILITY_PROFILES);

const NOW_MS = Date.parse("2026-08-08T00:00:00Z");

const durableCandidate = valkeyPackCandidate(verifiedValkeyPack(), {
	yardId: "yard.local",
	evidenceExpiresAtMs: NOW_MS + 30 * 24 * 60 * 60 * 1000,
	evidenceSignatureValid: true,
	durabilityMode: "aof-everysec",
	evictionPolicy: "noeviction",
});

const cacheCandidate = valkeyPackCandidate(verifiedValkeyPack(), {
	yardId: "yard.local",
	evidenceExpiresAtMs: NOW_MS + 30 * 24 * 60 * 60 * 1000,
	evidenceSignatureValid: true,
	durabilityMode: "none",
	evictionPolicy: "allkeys-lru",
});

function select(
	requirement: Parameters<typeof parseCapabilityRequirement>[0],
	candidate = durableCandidate,
	policy = DEFAULT_TRUST_POLICY,
) {
	return selectCapabilityImplementation({
		requirement: parseCapabilityRequirement(requirement),
		registry,
		candidates: [candidate],
		policy,
		nowMs: NOW_MS,
	});
}

describe("the valkey pack as a selection candidate", () => {
	it("satisfies a kv.redis-compatible/v1 requirement", () => {
		const result = select({
			requiredProfiles: [{ profileId: "kv.redis-compatible/v1" }],
		});
		assert.equal(result.winner?.definitionId, VALKEY_PACK_DEFINITION_ID);
		assert.deepEqual(result.rejections, []);
	});

	it("satisfies kv.valkey/v1 and kv.key-value/v1", () => {
		assert.equal(
			select({ requiredProfiles: [{ profileId: "kv.valkey/v1" }] }).winner
				?.definitionId,
			VALKEY_PACK_DEFINITION_ID,
		);
		// Through refinement: kv.valkey refines kv.redis-compatible refines
		// kv.key-value.
		assert.equal(
			select({ requiredProfiles: [{ profileId: "kv.key-value/v1" }] }).winner
				?.definitionId,
			VALKEY_PACK_DEFINITION_ID,
		);
	});

	it("is rejected as PROFILE_INCOMPATIBLE for a queue requirement", () => {
		const result = select({
			requiredProfiles: [{ profileId: "queue.at-least-once/v1" }],
		});
		assert.equal(result.winner, undefined);
		assert.equal(result.rejections[0]?.code, "PROFILE_INCOMPATIBLE");
	});

	it("is rejected for every other queue and topic profile too", () => {
		for (const profileId of [
			"queue.fifo/v1",
			"queue.delay/v1",
			"queue.dead-letter/v1",
			"topic.pubsub/v1",
			"topic.ephemeral-pubsub/v1",
			"topic.durable-log/v1",
			"topic.consumer-groups/v1",
		]) {
			const result = select({ requiredProfiles: [{ profileId }] });
			assert.equal(
				result.winner,
				undefined,
				`${profileId} must not select this pack`,
			);
			assert.equal(
				result.rejections[0]?.code,
				"PROFILE_INCOMPATIBLE",
				`${profileId} must be rejected as incompatible`,
			);
		}
	});

	it("is rejected even when a queue requirement is paired with the kv profile it does satisfy", () => {
		// The realistic shape of the mistake: "I need a cache and a queue, and
		// this thing does both."
		const result = select({
			requiredProfiles: [
				{ profileId: "kv.redis-compatible/v1" },
				{ profileId: "queue.at-least-once/v1" },
			],
		});
		assert.equal(result.winner, undefined);
		assert.equal(result.rejections[0]?.code, "PROFILE_INCOMPATIBLE");
	});

	it("advertises realization pack, so a policy that forbids packs excludes it", () => {
		for (const implementation of durableCandidate.implementsProfiles) {
			assert.equal(implementation.realization, "pack");
		}
		const result = select(
			{ requiredProfiles: [{ profileId: "kv.redis-compatible/v1" }] },
			durableCandidate,
			{ ...DEFAULT_TRUST_POLICY, allowPack: false },
		);
		assert.equal(result.winner, undefined);
		assert.equal(result.rejections[0]?.code, "REALIZATION_DENIED");
	});

	it("costs no sponsor exposure and needs no claim", () => {
		assert.equal(durableCandidate.sponsorExposureMinorUnits, 0);
		assert.equal(durableCandidate.claimActionCount, 0);
		assert.equal(durableCandidate.creatorAuthorityAfterClaim, "absent");
		assert.equal(durableCandidate.continuity.endpoint, "preserved");
		assert.equal(durableCandidate.continuity.data, "preserved");
	});

	it("reports the retention facts of the deployment rather than of the image", () => {
		assert.equal(
			durableCandidate.structuredCapabilities.durability,
			"aof-everysec",
		);
		assert.equal(
			durableCandidate.structuredCapabilities.keyLossPossible,
			false,
		);
		assert.equal(durableCandidate.structuredCapabilities.durableKeyspace, true);
		assert.equal(durableCandidate.structuredCapabilities.worstCaseLossMs, 1000);

		// Same image, same pack, different guarantee.
		assert.equal(cacheCandidate.structuredCapabilities.durability, "none");
		assert.equal(cacheCandidate.structuredCapabilities.keyLossPossible, true);
		assert.equal(cacheCandidate.structuredCapabilities.durableKeyspace, false);
		assert.equal(cacheCandidate.structuredCapabilities.survivesRestart, false);
	});

	it("does not win a requirement for a durable keyspace when deployed as a cache", () => {
		const requirement = {
			requiredProfiles: [{ profileId: "kv.key-value/v1" }],
			features: [
				{
					key: "durableKeyspace",
					operator: "equals",
					value: true,
					necessity: "required",
				},
			],
		} as const;
		assert.equal(
			select(requirement, durableCandidate).winner?.definitionId,
			VALKEY_PACK_DEFINITION_ID,
		);

		const cacheResult = select(requirement, cacheCandidate);
		assert.equal(cacheResult.winner, undefined);
		assert.equal(cacheResult.rejections[0]?.code, "FEATURE_UNSATISFIED");
	});

	it("does not claim a REST transport or TLS it cannot enforce", () => {
		assert.equal(durableCandidate.structuredCapabilities.restTransport, false);
		assert.equal(durableCandidate.structuredCapabilities.tls, false);
		const result = select({
			requiredProfiles: [{ profileId: "kv.redis-compatible/v1" }],
			features: [
				{
					key: "restTransport",
					operator: "equals",
					value: true,
					necessity: "required",
				},
			],
		});
		assert.equal(result.winner, undefined);
		assert.equal(result.rejections[0]?.code, "FEATURE_UNSATISFIED");
	});

	it("is rejected on stale evidence rather than trusted indefinitely", () => {
		const stale = valkeyPackCandidate(verifiedValkeyPack(), {
			yardId: "yard.local",
			evidenceExpiresAtMs: NOW_MS - 1,
			evidenceSignatureValid: true,
			durabilityMode: "aof-everysec",
			evictionPolicy: "noeviction",
		});
		const result = select(
			{ requiredProfiles: [{ profileId: "kv.redis-compatible/v1" }] },
			stale,
		);
		assert.equal(result.winner, undefined);
		assert.equal(result.rejections[0]?.code, "EVIDENCE_STALE");
	});

	it("produces a binding a redis-speaking workload can consume", () => {
		const result = selectCapabilityImplementation({
			requirement: parseCapabilityRequirement({
				requiredProfiles: [{ profileId: "kv.redis-compatible/v1" }],
			}),
			registry,
			candidates: [durableCandidate],
			policy: DEFAULT_TRUST_POLICY,
			nowMs: NOW_MS,
			consumableBindingProfiles: ["binding.redis-protocol/v1"],
		});
		assert.equal(result.winner?.definitionId, VALKEY_PACK_DEFINITION_ID);
	});
});
