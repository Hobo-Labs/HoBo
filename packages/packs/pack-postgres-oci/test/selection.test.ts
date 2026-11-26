/**
 * The claim this package exists to prove: a container satisfies the same
 * capability profile a managed product does, and is selected by the same
 * machinery — while remaining honest about being a pack.
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
	POSTGRES_PACK_DEFINITION_ID,
	postgresPackCandidate,
} from "../src/index.js";
import { verifiedPostgresPack } from "./harness.js";

const registry = createCapabilityProfileRegistry(STANDARD_CAPABILITY_PROFILES);

const NOW_MS = Date.parse("2026-08-08T00:00:00Z");

const candidate = postgresPackCandidate(verifiedPostgresPack(), {
	yardId: "yard.local",
	evidenceExpiresAtMs: NOW_MS + 30 * 24 * 60 * 60 * 1000,
	evidenceSignatureValid: true,
});

function select(
	requirement: Parameters<typeof parseCapabilityRequirement>[0],
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

describe("the postgres pack as a selection candidate", () => {
	it("satisfies a data.postgres/v1 requirement", () => {
		const result = select({
			requiredProfiles: [{ profileId: "data.postgres/v1" }],
		});
		assert.equal(result.winner?.definitionId, POSTGRES_PACK_DEFINITION_ID);
		assert.deepEqual(result.rejections, []);
	});

	it("satisfies a data.relational/v1 requirement through refinement", () => {
		const result = select({
			requiredProfiles: [{ profileId: "data.relational/v1" }],
		});
		assert.equal(result.winner?.definitionId, POSTGRES_PACK_DEFINITION_ID);
	});

	it("advertises realization pack, so a policy that forbids packs excludes it", () => {
		for (const implementation of candidate.implementsProfiles) {
			assert.equal(implementation.realization, "pack");
		}
		const result = select(
			{ requiredProfiles: [{ profileId: "data.postgres/v1" }] },
			{ ...DEFAULT_TRUST_POLICY, allowPack: false },
		);
		assert.equal(result.winner, undefined);
		assert.equal(result.rejections[0]?.code, "REALIZATION_DENIED");
	});

	it("is excluded when the requirement itself disallows pack realization", () => {
		const result = select({
			requiredProfiles: [{ profileId: "data.postgres/v1" }],
			realization: { allowPack: false },
		});
		assert.equal(result.rejections[0]?.code, "REALIZATION_DENIED");
	});

	it("is not selectable for a key/value requirement", () => {
		const result = select({
			requiredProfiles: [{ profileId: "kv.redis-compatible/v1" }],
		});
		assert.equal(result.winner, undefined);
		assert.equal(result.rejections[0]?.code, "PROFILE_INCOMPATIBLE");
	});

	it("costs the operator no sponsor exposure and no claim actions", () => {
		assert.equal(candidate.sponsorExposureMinorUnits, 0);
		assert.equal(candidate.claimActionCount, 0);
		assert.equal(candidate.creatorAuthorityAfterClaim, "absent");
		// Yard-owned means the endpoint and data are never disturbed by a claim.
		assert.equal(candidate.continuity.endpoint, "preserved");
		assert.equal(candidate.continuity.data, "preserved");
	});

	it("survives the strictest claim policy, because nothing has to be claimed", () => {
		const result = select(
			{ requiredProfiles: [{ profileId: "data.postgres/v1" }] },
			{
				...DEFAULT_TRUST_POLICY,
				creatorAuthorityAfterClaim: "must-be-absent",
				maximumClaimActions: 0,
				requireExportProfile: true,
			},
		);
		assert.equal(result.winner?.definitionId, POSTGRES_PACK_DEFINITION_ID);
	});

	it("is rejected on stale evidence rather than trusted indefinitely", () => {
		const stale = postgresPackCandidate(verifiedPostgresPack(), {
			yardId: "yard.local",
			evidenceExpiresAtMs: NOW_MS - 1,
			evidenceSignatureValid: true,
		});
		const result = selectCapabilityImplementation({
			requirement: parseCapabilityRequirement({
				requiredProfiles: [{ profileId: "data.postgres/v1" }],
			}),
			registry,
			candidates: [stale],
			policy: DEFAULT_TRUST_POLICY,
			nowMs: NOW_MS,
		});
		assert.equal(result.winner, undefined);
		assert.equal(result.rejections[0]?.code, "EVIDENCE_STALE");
	});

	it("does not claim a pooled endpoint or TLS it cannot enforce", () => {
		assert.equal(candidate.structuredCapabilities.pooling, false);
		assert.equal(candidate.structuredCapabilities.tls, false);
		const result = select({
			requiredProfiles: [{ profileId: "data.postgres/v1" }],
			guarantees: [{ key: "tls", operator: "equals", value: true }],
		});
		assert.equal(result.winner, undefined);
		assert.equal(result.rejections[0]?.code, "GUARANTEE_UNSATISFIED");
	});

	it("offers the pg-dump migration profile a portability-conscious requirement asks for", () => {
		const result = select({
			requiredProfiles: [{ profileId: "data.postgres/v1" }],
			portability: {
				requireExportProfile: true,
				requiredMigrationProfiles: ["migration.postgres.pg-dump/v1"],
			},
		});
		assert.equal(result.winner?.definitionId, POSTGRES_PACK_DEFINITION_ID);
	});

	it("produces a binding a postgres-consuming workload can actually use", () => {
		const result = selectCapabilityImplementation({
			requirement: parseCapabilityRequirement({
				requiredProfiles: [{ profileId: "data.postgres/v1" }],
			}),
			registry,
			candidates: [candidate],
			policy: DEFAULT_TRUST_POLICY,
			nowMs: NOW_MS,
			consumableBindingProfiles: ["binding.postgresql/v1"],
		});
		assert.equal(result.winner?.definitionId, POSTGRES_PACK_DEFINITION_ID);
	});
});
