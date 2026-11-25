/**
 * Redis has lists and pub/sub, so the tempting shortcut is to let a
 * Redis-compatible store satisfy a queue or a topic. These tests are the
 * standing refusal.
 */
import {
	createCapabilityProfileRegistry,
	DEFAULT_TRUST_POLICY,
	type ProfileImplementation,
	parseCapabilityRequirement,
	type SelectionCandidate,
	STANDARD_CAPABILITY_PROFILES,
	selectCapabilityImplementation,
	type TrustPolicy,
} from "@hobo/capability-profiles";
import { describe, expect, it } from "vitest";

import {
	assertNoQueueTopicImplication,
	explainNonImplication,
	findQueueTopicImplications,
	KV_REDIS_NON_IMPLIED_PROFILES,
	KvRedisCompatibleError,
	redisCompatible,
} from "../src/index.js";

const profiles = createCapabilityProfileRegistry(STANDARD_CAPABILITY_PROFILES);
const NOW = Date.UTC(2026, 7, 8);

const policy: TrustPolicy = {
	...DEFAULT_TRUST_POLICY,
	minimumProviderClass: "experimental",
	creatorAuthorityAfterClaim: "may-be-retained",
	maximumClaimActions: 4,
};

const KV_CONFORMANCE_REF = "conformance.kv.redis-compatible/v1#reference";

const KV_ONLY_IMPLEMENTATIONS: readonly ProfileImplementation[] = [
	{
		profileId: "kv.key-value/v1",
		versionRange: ">=1",
		realization: "native",
		conformanceRef: KV_CONFORMANCE_REF,
		conformance: "pass",
	},
	{
		profileId: "kv.redis-compatible/v1",
		versionRange: ">=1",
		realization: "native",
		conformanceRef: KV_CONFORMANCE_REF,
		conformance: "pass",
	},
];

/**
 * A store that advertises the full Redis data-type surface — lists, streams,
 * pub/sub — and nothing about delivery.
 */
const redisOnlyCandidate: SelectionCandidate = {
	definitionId: "reference.redis-compatible-store/v1",
	providerId: "reference",
	implementsProfiles: KV_ONLY_IMPLEMENTATIONS,
	runtimeModels: ["wasm", "oci", "vm_iaas", "paas", "serverless_faas"],
	structuredCapabilities: {
		redisCommandSemantics: true,
		ttl: true,
		atomicIncrement: true,
		atomicCompareAndSet: true,
		sortedSets: true,
		restTransport: true,
		// The tempting ones. Having the data structure is not having the
		// delivery contract, and selection must not read these as one.
		lists: true,
		streams: true,
		pubsub: true,
	},
	producesBindingProfiles: ["binding.redis-rest/v1"],
	migrationProfiles: [],
	providerClass: "experimental",
	evidenceExpiresAtMs: NOW + 86_400_000,
	evidenceSignatureValid: true,
	creatorAuthorityAfterClaim: "rotatable",
	claimAtomicity: "single-resource",
	claimActionCount: 1,
	continuity: {
		endpoint: "preserved",
		data: "preserved",
		credentials: "retained",
	},
	supportsExport: false,
	supportsRotation: true,
	supportsRevocation: true,
	sponsorExposureMinorUnits: 0,
	hasRegisteredDriver: true,
	secretCustodyAvailable: true,
};

function select(profileId: string) {
	return selectCapabilityImplementation({
		requirement: parseCapabilityRequirement({
			requiredProfiles: [{ profileId, versionRange: ">=1" }],
		}),
		registry: profiles,
		candidates: [redisOnlyCandidate],
		policy,
		nowMs: NOW,
	});
}

describe("a Redis-compatible store satisfies a Redis-compatible requirement", () => {
	it("is selected for the store requirement it was actually tested against", () => {
		const outcome = selectCapabilityImplementation({
			requirement: redisCompatible.store({ ttl: true, atomicIncrement: true }),
			registry: profiles,
			candidates: [redisOnlyCandidate],
			policy,
			nowMs: NOW,
		});
		expect(outcome.winner?.definitionId).toBe(
			"reference.redis-compatible-store/v1",
		);
	});

	it("satisfies the plain key/value profile through refinement", () => {
		expect(select("kv.key-value/v1").winner).toBeDefined();
	});
});

describe("it satisfies no delivery requirement", () => {
	for (const profileId of KV_REDIS_NON_IMPLIED_PROFILES) {
		it(`is rejected for ${profileId} with PROFILE_INCOMPATIBLE`, () => {
			const outcome = select(profileId);
			expect(outcome.winner).toBeUndefined();
			expect(outcome.ranked).toEqual([]);
			expect(outcome.rejections.map((rejection) => rejection.code)).toEqual([
				"PROFILE_INCOMPATIBLE",
			]);
			expect(outcome.rejections[0]?.detail).toContain(profileId);
		});
	}

	it("is rejected for the ephemeral pub/sub profile too, despite Redis having pub/sub", () => {
		expect(
			select("topic.ephemeral-pubsub/v1").rejections.map((r) => r.code),
		).toEqual(["PROFILE_INCOMPATIBLE"]);
	});

	it("explains every non-implication in terms of the missing guarantee", () => {
		for (const profileId of KV_REDIS_NON_IMPLIED_PROFILES) {
			expect(explainNonImplication(profileId)?.length ?? 0).toBeGreaterThan(60);
		}
		expect(explainNonImplication("kv.redis-compatible/v1")).toBeUndefined();
	});
});

describe("the declaration guard", () => {
	it("passes a declaration that only claims key/value profiles", () => {
		expect(findQueueTopicImplications(KV_ONLY_IMPLEMENTATIONS)).toEqual([]);
		expect(() =>
			assertNoQueueTopicImplication(KV_ONLY_IMPLEMENTATIONS),
		).not.toThrow();
	});

	it("rejects a queue claim that leans on the key/value conformance run", () => {
		const overreach: readonly ProfileImplementation[] = [
			...KV_ONLY_IMPLEMENTATIONS,
			{
				profileId: "queue.at-least-once/v1",
				versionRange: ">=1",
				realization: "native",
				// The tell: the same conformance run as the store.
				conformanceRef: KV_CONFORMANCE_REF,
				conformance: "pass",
			},
		];
		expect(
			findQueueTopicImplications(overreach).map((v) => v.profileId),
		).toEqual(["queue.at-least-once/v1"]);
		expect(() =>
			assertNoQueueTopicImplication(overreach, "the reference product"),
		).toThrow(KvRedisCompatibleError);
	});

	it("allows a queue claim that carries its own independent evidence", () => {
		const honest: readonly ProfileImplementation[] = [
			...KV_ONLY_IMPLEMENTATIONS,
			{
				profileId: "queue.at-least-once/v1",
				versionRange: ">=1",
				realization: "native",
				conformanceRef: "conformance.queue.at-least-once/v1#reference",
				conformance: "pass",
			},
		];
		expect(() => assertNoQueueTopicImplication(honest)).not.toThrow();
	});

	it("names the missing guarantee in the failure, not just the profile id", () => {
		try {
			assertNoQueueTopicImplication([
				...KV_ONLY_IMPLEMENTATIONS,
				{
					profileId: "topic.durable-log/v1",
					versionRange: ">=1",
					realization: "native",
					conformanceRef: KV_CONFORMANCE_REF,
					conformance: "pass",
				},
			]);
			expect.unreachable("the guard should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(KvRedisCompatibleError);
			// SAFETY: `expect((error as KvRedisCompatibleError).code).toBe(` is required at this I/O or test boundary.
			expect((error as KvRedisCompatibleError).code).toBe(
				"QUEUE_TOPIC_IMPLICATION",
			);
			// SAFETY: `expect((error as Error).message).toMatch(/retains|offset/u);` is required at this I/O or test boundary.
			expect((error as Error).message).toMatch(/retains|offset/u);
		}
	});
});
