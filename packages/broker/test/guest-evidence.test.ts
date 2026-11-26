import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	assertGuestEvidenceMatchesOffer,
	type GuestResolutionEvidence,
	type GuestResolutionInput,
	parseGuestResolutionEvidence,
	parseGuestResolutionInput,
} from "../src/guest-evidence.js";
import type { JsonObject } from "../src/json.js";
import { canonicalResolutionJson } from "../src/signing.js";
import type { ResolutionReceipt } from "../src/types.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;
const DIGEST_D = `sha256:${"d".repeat(64)}`;

function input(overrides: Partial<GuestResolutionInput> = {}): JsonObject {
	return {
		recipeId: "claimable-webhook-inbox",
		topologyDigest: DIGEST_A,
		offerDigest: DIGEST_B,
		consentDigest: DIGEST_C,
		bootstrapClass: "public-anonymous",
		sponsorCostCapMinorUnits: 0,
		maxClaimActions: 2,
		...overrides,
	};
}

function placement(overrides: JsonObject = {}): JsonObject {
	return {
		resourceId: "api",
		definitionId: "cloudflare.claimable-worker/v1",
		realization: "native",
		runtimeModel: "serverless_faas",
		capabilityProfileRefs: ["api.http/v1"],
		bootstrapClass: "public-anonymous",
		claimMode: "account-claim",
		creatorAuthorityAfterClaim: "reauthorization-required",
		...overrides,
	};
}

function evidence(overrides: JsonObject = {}): JsonObject {
	return {
		recipeId: "claimable-webhook-inbox",
		topologyDigest: DIGEST_A,
		offerDigest: DIGEST_B,
		consentDigest: DIGEST_C,
		guestLeaseId: "lease-1",
		leaseExpiresAt: "2026-08-09T12:00:00Z",
		claimBundleId: "bundle-1",
		claimAtomicity: "single-resource",
		claimActionCount: 1,
		earliestClaimDeadline: "2026-08-08T23:55:00Z",
		placements: [placement()],
		trustEvidenceRefs: ["trust:cloudflare/temporary-account@2026-08-01"],
		conformanceRefs: ["conformance:api.http/v1@2026-08-01"],
		sponsorCostCapMinorUnits: 0,
		cleanupPolicy: "delete",
		...overrides,
	};
}

describe("guest resolution input", () => {
	it("parses an anonymous offer acceptance", () => {
		const parsed = parseGuestResolutionInput(input());
		assert.equal(parsed.bootstrapClass, "public-anonymous");
		assert.equal(parsed.sponsorCostCapMinorUnits, 0);
	});

	it("refuses a public-anonymous request that carries a sponsor budget", () => {
		assert.throws(
			() => parseGuestResolutionInput(input({ sponsorCostCapMinorUnits: 500 })),
			/must be zero for a public-anonymous bootstrap/u,
		);
	});

	it("refuses a sponsor-backed request with no budget to spend", () => {
		assert.throws(
			() =>
				parseGuestResolutionInput(
					input({
						bootstrapClass: "sponsor-backed",
						sponsorCostCapMinorUnits: 0,
					}),
				),
			/sponsor-backed/u,
		);
	});

	it("refuses a digest that is not a sha256 content address", () => {
		assert.throws(
			() => parseGuestResolutionInput(input({ topologyDigest: "abc" })),
			/topologyDigest/u,
		);
	});
});

describe("guest resolution evidence", () => {
	it("parses a single-claim Cloudflare deployment", () => {
		const parsed = parseGuestResolutionEvidence(evidence());
		assert.equal(parsed.claimActionCount, 1);
		assert.equal(parsed.placements[0]?.realization, "native");
	});

	it("requires a deadline whenever a human must act", () => {
		assert.throws(
			() =>
				parseGuestResolutionEvidence(
					evidence({ earliestClaimDeadline: undefined }),
				),
			/earliestClaimDeadline/u,
		);
	});

	it("refuses single-resource atomicity across two ownership ceremonies", () => {
		assert.throws(
			() =>
				parseGuestResolutionEvidence(
					evidence({
						claimActionCount: 2,
						placements: [
							placement(),
							placement({
								resourceId: "db",
								definitionId: "neon.claimable-postgres/v1",
								capabilityProfileRefs: ["data.postgres/v1"],
								claimMode: "resource-claim",
							}),
						],
					}),
				),
			/single-resource/u,
		);
	});

	it("refuses a bridge placement that names no connectivity implementation", () => {
		assert.throws(
			() =>
				parseGuestResolutionEvidence(
					evidence({
						placements: [placement({ realization: "bridge" })],
					}),
				),
			/connectivityRef/u,
		);
	});

	it("accepts a bridge placement that names one", () => {
		const parsed = parseGuestResolutionEvidence(
			evidence({
				placements: [
					placement({
						realization: "bridge",
						connectivityRef: "cloudflare.postgres.hyperdrive/v1",
					}),
				],
			}),
		);
		assert.equal(
			parsed.placements[0]?.connectivityRef,
			"cloudflare.postgres.hyperdrive/v1",
		);
	});

	it("requires trust and conformance evidence for every guest resolution", () => {
		assert.throws(
			() => parseGuestResolutionEvidence(evidence({ trustEvidenceRefs: [] })),
			/trustEvidenceRefs/u,
		);
		assert.throws(
			() => parseGuestResolutionEvidence(evidence({ conformanceRefs: [] })),
			/conformanceRefs/u,
		);
	});

	it("requires a sponsor budget when any placement is sponsor-backed", () => {
		assert.throws(
			() =>
				parseGuestResolutionEvidence(
					evidence({
						placements: [
							placement({
								definitionId: "vercel.sponsored-claim-deployment/v1",
								bootstrapClass: "sponsor-backed",
								claimMode: "project-transfer",
							}),
						],
					}),
				),
			/sponsor-budget-exceeded/u,
		);
	});
});

describe("offer and evidence agreement", () => {
	const accepted = parseGuestResolutionInput(input());

	it("accepts evidence for the topology the human consented to", () => {
		assertGuestEvidenceMatchesOffer(
			parseGuestResolutionEvidence(evidence()),
			accepted,
		);
	});

	it("refuses evidence whose topology drifted from the accepted offer", () => {
		assert.throws(
			() =>
				assertGuestEvidenceMatchesOffer(
					parseGuestResolutionEvidence(evidence({ topologyDigest: DIGEST_D })),
					accepted,
				),
			/guest-offer-mismatch/u,
		);
	});

	it("refuses more ownership ceremonies than the human accepted", () => {
		const oneAction = parseGuestResolutionInput(input({ maxClaimActions: 1 }));
		assert.throws(
			() =>
				assertGuestEvidenceMatchesOffer(
					parseGuestResolutionEvidence(
						evidence({
							claimAtomicity: "best-effort-saga",
							claimActionCount: 2,
						}),
					),
					oneAction,
				),
			/claim actions/u,
		);
	});
});

describe("receipt signing surface", () => {
	it("covers guest evidence in the canonical signing payload", () => {
		// SAFETY: assertion required at this I/O or test boundary.
		const guest = parseGuestResolutionEvidence(
			evidence(),
		) as GuestResolutionEvidence;
		const receipt: ResolutionReceipt = {
			schemaVersion: "hobo.broker/v1",
			requestId: "req-1",
			brokerId: "broker-1",
			catalogHash: DIGEST_A,
			// SAFETY: assertion required at this I/O or test boundary.
			policyHash: DIGEST_B as ResolutionReceipt["policyHash"],
			placementPolicyId: "default",
			placements: [
				{
					resourceId: "api",
					providerId: "cloudflare",
					definitionId: "cloudflare.claimable-worker/v1",
					region: "global",
					sku: "worker",
					unit: "request",
					marginalPrice: "0",
				},
			],
			stationId: "station-1",
			railHash: DIGEST_C,
			guest,
		};
		const canonical = canonicalResolutionJson(receipt);
		assert.ok(canonical.includes("bundle-1"));
		assert.ok(canonical.includes("reauthorization-required"));
		// Tampering with claim evidence changes the signed bytes.
		const tampered = canonicalResolutionJson({
			...receipt,
			guest: { ...guest, claimActionCount: 0 },
		});
		assert.notEqual(canonical, tampered);
	});
});
