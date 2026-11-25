/**
 * The declaration is the part of this package a planner reads without ever
 * calling the driver, so an over-claim here is worse than a bug in the client:
 * it is a promise made to a selection algorithm that no code will ever check.
 *
 * These tests hold the declaration to what the package actually implements —
 * a Redis-compatible store, REST only, no delivery semantics, no invented
 * limits — and pin the selection outcomes that follow from it.
 */
import {
	createCapabilityProfileRegistry,
	DEFAULT_TRUST_POLICY,
	parseCapabilityRequirement,
	STANDARD_CAPABILITY_PROFILES,
	selectCapabilityImplementation,
	type TrustPolicy,
} from "@hobo/capability-profiles";
import {
	findQueueTopicImplications,
	KV_REDIS_NON_IMPLIED_PROFILES,
	redisCompatible,
	valkey,
} from "@hobo/kv-redis-compatible";
import { describe, expect, it } from "vitest";

import {
	createUpstashTemporaryRedisCandidate,
	UPSTASH_ALIAS_DEFINITION_ID,
	UPSTASH_BINDING_PROFILE_REFS,
	UPSTASH_CLAIM_ACTION_COUNT,
	UPSTASH_CLAIM_STRATEGY_REF,
	UPSTASH_DEFINITION_ID,
	UPSTASH_PROFILE_IMPLEMENTATIONS,
	UPSTASH_RESOURCE_DEFINITION,
	UPSTASH_RESOURCE_SEMANTICS,
	UPSTASH_SOURCE_REFS,
	UPSTASH_STRUCTURED_CAPABILITIES,
	UPSTASH_TEMPORARY_REDIS_CANDIDATE,
	UPSTASH_UNCLAIMED_LIMITS,
} from "../src/definition.js";

const profiles = createCapabilityProfileRegistry(STANDARD_CAPABILITY_PROFILES);

/** Well inside the 90-day evidence window the declaration sets. */
const NOW = Date.UTC(2026, 7, 8);

/**
 * The anonymous surface is `experimental`-adjacent and the creating party
 * keeps its token until a human rotates it, so the default policy would reject
 * this candidate on trust grounds before ever reaching a profile decision.
 * These tests are about profile matching, so the trust dials are opened and
 * the trust behaviour is asserted separately below.
 */
const permissivePolicy: TrustPolicy = {
	...DEFAULT_TRUST_POLICY,
	minimumProviderClass: "experimental",
	creatorAuthorityAfterClaim: "may-be-retained",
	maximumClaimActions: UPSTASH_CLAIM_ACTION_COUNT,
};

function selectFor(profileId: string, policy: TrustPolicy = permissivePolicy) {
	return selectCapabilityImplementation({
		requirement: parseCapabilityRequirement({
			requiredProfiles: [{ profileId, versionRange: ">=1" }],
		}),
		registry: profiles,
		candidates: [UPSTASH_TEMPORARY_REDIS_CANDIDATE],
		policy,
		nowMs: NOW,
	});
}

describe("the declared product", () => {
	it("implements the two kv profiles natively and nothing else", () => {
		expect(
			UPSTASH_PROFILE_IMPLEMENTATIONS.map(
				(implementation) => implementation.profileId,
			).sort(),
		).toEqual(["kv.key-value/v1", "kv.redis-compatible/v1"]);
		expect(
			UPSTASH_PROFILE_IMPLEMENTATIONS.every(
				(implementation) => implementation.realization === "native",
			),
		).toBe(true);
	});

	it("carries no delivery profile leaning on the store's conformance run", () => {
		expect(findQueueTopicImplications(UPSTASH_PROFILE_IMPLEMENTATIONS)).toEqual(
			[],
		);
	});

	it("produces only the REST binding, because only REST is conformance-backed", () => {
		expect(UPSTASH_BINDING_PROFILE_REFS).toEqual(["binding.redis-rest/v1"]);
		// Upstash databases do speak RESP over TLS. This package has no
		// evidence for it, so it must not appear.
		expect(UPSTASH_RESOURCE_SEMANTICS.producesBindingProfiles).not.toContain(
			"binding.redis-protocol/v1",
		);
	});

	it("quotes no limit it cannot observe", () => {
		// The account free tier publishes numbers. This surface does not, and
		// borrowing them would be an invented fact that a planner would then
		// enforce.
		expect(UPSTASH_STRUCTURED_CAPABILITIES.maxValueBytes).toBeUndefined();
		expect(UPSTASH_RESOURCE_DEFINITION.regions).toEqual([]);
		expect(UPSTASH_UNCLAIMED_LIMITS.documentedExpiryHours).toBe(72);
	});

	it("declares the anonymous claim shape the driver implements", () => {
		expect(UPSTASH_RESOURCE_SEMANTICS.claimStrategyRef).toBe(
			UPSTASH_CLAIM_STRATEGY_REF,
		);
		// The console ceremony, then the owner's rotation.
		expect(UPSTASH_RESOURCE_SEMANTICS.claimActionCount).toBe(2);
		expect(UPSTASH_RESOURCE_SEMANTICS.secretCustodyAvailable).toBe(true);
		// No delete endpoint and no export endpoint exist on this surface.
		expect(UPSTASH_RESOURCE_SEMANTICS.supportsRevocation).toBe(false);
		expect(UPSTASH_RESOURCE_SEMANTICS.supportsExport).toBe(false);
		expect(UPSTASH_RESOURCE_SEMANTICS.migrationProfiles).toEqual([]);
		// Anonymous, on the provider's own allowance.
		expect(UPSTASH_RESOURCE_SEMANTICS.sponsorExposureMinorUnits).toBe(0);
	});

	it("dates every source it rests on", () => {
		expect(UPSTASH_SOURCE_REFS.length).toBeGreaterThan(0);
		for (const source of UPSTASH_SOURCE_REFS) {
			expect(source.url).toMatch(/^https:\/\//u);
			expect(source.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
			expect(source.note.length).toBeGreaterThan(20);
		}
	});

	it("resolves the alias to the same product rather than a second one", () => {
		const alias = createUpstashTemporaryRedisCandidate({
			definitionId: UPSTASH_ALIAS_DEFINITION_ID,
		});
		expect(alias.definitionId).toBe(UPSTASH_ALIAS_DEFINITION_ID);
		const { definitionId: _aliasId, ...aliasRest } = alias;
		const { definitionId: _canonicalId, ...canonicalRest } =
			UPSTASH_TEMPORARY_REDIS_CANDIDATE;
		expect(aliasRest).toEqual(canonicalRest);
	});
});

describe("selection for a store requirement", () => {
	it("wins the Redis-compatible requirement it is tested against", () => {
		const outcome = selectCapabilityImplementation({
			requirement: redisCompatible.store({
				ttl: true,
				atomicIncrement: true,
				sortedSets: true,
				restTransport: true,
			}),
			registry: profiles,
			candidates: [UPSTASH_TEMPORARY_REDIS_CANDIDATE],
			policy: permissivePolicy,
			nowMs: NOW,
		});
		expect(outcome.winner?.definitionId).toBe(UPSTASH_DEFINITION_ID);
	});

	it("satisfies the plain key/value requirement", () => {
		expect(selectFor("kv.key-value/v1").winner).toBeDefined();
	});

	it("is rejected for a value size it never advertised", () => {
		const outcome = selectCapabilityImplementation({
			requirement: redisCompatible.store({ minValueBytes: 1024 }),
			registry: profiles,
			candidates: [UPSTASH_TEMPORARY_REDIS_CANDIDATE],
			policy: permissivePolicy,
			nowMs: NOW,
		});
		// Absent is not "probably fine": a required feature gate over an
		// unadvertised capability has to fail closed.
		expect(outcome.winner).toBeUndefined();
	});

	it("is rejected for Valkey, which it does not claim to be", () => {
		const outcome = selectCapabilityImplementation({
			requirement: valkey.store(),
			registry: profiles,
			candidates: [UPSTASH_TEMPORARY_REDIS_CANDIDATE],
			policy: permissivePolicy,
			nowMs: NOW,
		});
		expect(outcome.winner).toBeUndefined();
		expect(outcome.rejections.map((rejection) => rejection.code)).toEqual([
			"PROFILE_INCOMPATIBLE",
		]);
	});
});

describe("selection for a delivery requirement", () => {
	for (const profileId of KV_REDIS_NON_IMPLIED_PROFILES) {
		it(`rejects the Upstash candidate for ${profileId} with PROFILE_INCOMPATIBLE`, () => {
			const outcome = selectFor(profileId);
			expect(outcome.winner).toBeUndefined();
			expect(outcome.ranked).toEqual([]);
			expect(outcome.rejections.map((rejection) => rejection.code)).toEqual([
				"PROFILE_INCOMPATIBLE",
			]);
		});
	}
});

describe("trust gating", () => {
	it("clears the default policy, because its authority is rotatable in two actions", () => {
		// This surface is anonymous, but it is not untrusted: the creating
		// party's token can be rotated away by the owner, and the claim takes
		// the two actions the default policy allows. Pinned because it is the
		// declaration's most consequential claim — if `rotatable` ever became
		// aspirational, a default workload would land here silently.
		expect(
			selectFor("kv.redis-compatible/v1", DEFAULT_TRUST_POLICY).winner,
		).toBeDefined();
	});

	it("is excluded by a policy that will not tolerate a retained creator token", () => {
		const outcome = selectFor("kv.redis-compatible/v1", {
			...DEFAULT_TRUST_POLICY,
			creatorAuthorityAfterClaim: "must-be-absent",
		});
		expect(outcome.winner).toBeUndefined();
	});

	it("is excluded by a policy that requires a way out", () => {
		// No export endpoint on this surface, so a portability-conscious
		// policy should never pick it.
		const outcome = selectFor("kv.redis-compatible/v1", {
			...DEFAULT_TRUST_POLICY,
			requireExportProfile: true,
		});
		expect(outcome.winner).toBeUndefined();
	});

	it("is rejected once its dated evidence has aged out", () => {
		const stale = createUpstashTemporaryRedisCandidate({
			evidenceExpiresAtMs: NOW - 1,
		});
		const outcome = selectCapabilityImplementation({
			requirement: redisCompatible.store(),
			registry: profiles,
			candidates: [stale],
			policy: permissivePolicy,
			nowMs: NOW,
		});
		expect(outcome.winner).toBeUndefined();
	});

	it("is rejected when the conformance run did not complete", () => {
		// `unknown` is what an incomplete offline run produces. It must not
		// be selectable.
		const unproven = createUpstashTemporaryRedisCandidate({
			conformance: "unknown",
		});
		const outcome = selectCapabilityImplementation({
			requirement: redisCompatible.store(),
			registry: profiles,
			candidates: [unproven],
			policy: permissivePolicy,
			nowMs: NOW,
		});
		expect(outcome.winner).toBeUndefined();
	});
});

describe("the legacy resource definition half", () => {
	it("matches a kv port request for the features it declares", () => {
		expect(UPSTASH_RESOURCE_DEFINITION.satisfies({ port: "kv" })).toEqual({
			kind: "full",
		});
		expect(
			UPSTASH_RESOURCE_DEFINITION.satisfies({ port: "kv", features: ["ttl"] }),
		).toEqual({ kind: "full" });
	});

	it("reports what is missing rather than matching loosely", () => {
		expect(
			UPSTASH_RESOURCE_DEFINITION.satisfies({
				port: "kv",
				features: ["deadLetter"],
			}),
		).toEqual({ kind: "partial", missing: ["deadLetter"] });
		expect(UPSTASH_RESOURCE_DEFINITION.satisfies({ port: "queue" })).toEqual({
			kind: "none",
		});
	});

	it("is a pure function of the declaration", () => {
		// No clock, no network, no ambient state: two calls agree, and the
		// definition can be serialized into a catalog.
		expect(UPSTASH_RESOURCE_DEFINITION.satisfies({ port: "kv" })).toEqual(
			UPSTASH_RESOURCE_DEFINITION.satisfies({ port: "kv" }),
		);
	});
});
