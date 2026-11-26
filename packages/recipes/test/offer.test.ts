import { describe, expect, it } from "vitest";

import {
	acceptOffer,
	assertOfferIsSecretFree,
	buildDeploymentOffer,
	canonicalOfferBytes,
	compileRecipe,
	type DeploymentOffer,
	findStandardRecipe,
	OfferSecretLeakError,
	offerDigest,
	parseDeploymentRequest,
	parseSolutionRecipe,
	type RecipeCompilationAccepted,
	type SolutionRecipe,
	verifyAcceptance,
} from "../src/index.js";
import {
	CATALOG_DIGEST,
	capabilityFor,
	compileInputFor,
	NOW,
	PROFILE_REGISTRY_DIGEST,
	requestForRecipe,
	SIGNER,
} from "./fixtures.js";

function requireRecipe(id: string): SolutionRecipe {
	const recipe = findStandardRecipe(id);
	if (recipe === undefined) throw new Error(`missing fixture recipe ${id}`);
	return recipe;
}

const sqlApi = requireRecipe("recipe.cloudflare-neon.portable-sql-api/v1");
const inbox = requireRecipe("recipe.cloudflare.claimable-webhook-inbox/v1");

function compiled(recipe: SolutionRecipe): RecipeCompilationAccepted {
	const compilation = compileRecipe(compileInputFor(recipe));
	if (!compilation.ok)
		throw new Error(`fixture recipe ${recipe.id} did not compile`);
	return compilation;
}

function offerFor(recipe: SolutionRecipe, issuedAtMs = NOW): DeploymentOffer {
	return buildDeploymentOffer({
		compilation: compiled(recipe),
		recipe,
		request: requestForRecipe(recipe),
		catalogDigest: CATALOG_DIGEST,
		profileRegistryDigest: PROFILE_REGISTRY_DIGEST,
		issuedAtMs,
		signer: SIGNER,
	});
}

describe("buildDeploymentOffer", () => {
	it("renders the whole proposal a caller consents to", () => {
		const offer = offerFor(sqlApi);
		expect(offer.schemaVersion).toBe("hobo.deployment-offer/v1");
		expect(offer.recipeId).toBe("recipe.cloudflare-neon.portable-sql-api/v1");
		expect(offer.providers.map((provider) => provider.providerId)).toEqual([
			"cloudflare",
			"neon",
		]);
		expect(offer.placements.map((placement) => placement.placementId)).toEqual([
			"api",
			"db",
		]);
		expect(offer.claimSummary.actionCount).toBe(2);
		expect(offer.claimSummary.providerCount).toBe(2);
		expect(offer.claimSummary.atomicity).toBe("best-effort-saga");
		expect(offer.guestLeases).toHaveLength(2);
		expect(offer.expiresAtMs).toBe(NOW + sqlApi.bootstrap.offerTtlMs);
		expect(offer.signature.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
	});

	it("reports a provider as resource-only only when every Yard it owns is", () => {
		const offer = offerFor(sqlApi);
		expect(offer.providers).toEqual([
			{ providerId: "cloudflare", sponsored: false, resourceOnly: false },
			{ providerId: "neon", sponsored: false, resourceOnly: true },
		]);
	});

	it("is byte-identical for the same compilation and issue instant", () => {
		expect(canonicalOfferBytes(offerFor(sqlApi))).toBe(
			canonicalOfferBytes(offerFor(sqlApi)),
		);
		expect(offerDigest(offerFor(sqlApi))).toBe(offerDigest(offerFor(sqlApi)));
	});

	it("refuses a non-positive issue instant and a malformed digest", () => {
		const compilation = compiled(inbox);
		const shared = {
			compilation,
			recipe: inbox,
			request: requestForRecipe(inbox),
			profileRegistryDigest: PROFILE_REGISTRY_DIGEST,
			signer: SIGNER,
		};
		expect(() =>
			buildDeploymentOffer({
				...shared,
				catalogDigest: CATALOG_DIGEST,
				issuedAtMs: 0,
			}),
		).toThrow(/issuedAtMs/u);
		expect(() =>
			buildDeploymentOffer({
				...shared,
				catalogDigest: "nope",
				issuedAtMs: NOW,
			}),
		).toThrow(/catalogDigest/u);
	});
});

describe("secret containment", () => {
	it("carries no secret-shaped string anywhere in its canonical bytes", () => {
		const bytes = canonicalOfferBytes(offerFor(sqlApi));
		expect(bytes).not.toMatch(/https?:\/\//iu);
		expect(bytes).not.toMatch(/postgres(?:ql)?:\/\//iu);
		expect(bytes).not.toMatch(/\bbearer\s/iu);
		expect(bytes).not.toMatch(/-----BEGIN/u);
		// Digests and refs are fine; the point is that nothing resolvable ships.
		expect(bytes).toContain("sha256:");
	});

	it("refuses to build an offer whose deployment ref is a claim URL", () => {
		const request = parseDeploymentRequest({
			deploymentRef: "https://claim.example.invalid/accept?token=abc123",
			capabilities: inbox.placements.map((placement) =>
				capabilityFor(placement.capabilityRef, placement.satisfiesProfileId),
			),
			requestedSemantics: inbox.delivers,
		});
		const compilation = compileRecipe(compileInputFor(inbox, { request }));
		if (!compilation.ok)
			throw new Error("the URL should reach the offer, not the gates");
		expect(() =>
			buildDeploymentOffer({
				compilation,
				recipe: inbox,
				request,
				catalogDigest: CATALOG_DIGEST,
				profileRegistryDigest: PROFILE_REGISTRY_DIGEST,
				issuedAtMs: NOW,
				signer: SIGNER,
			}),
		).toThrow(OfferSecretLeakError);
	});

	it("refuses to build an offer whose consent text smuggles a token URL", () => {
		const leaky = parseSolutionRecipe({
			...inbox,
			id: "recipe.test.leaky-consents/v1",
			bootstrap: {
				...inbox.bootstrap,
				requiredConsents: ["visit https://claim.example.invalid/?token=abc123"],
			},
		});
		expect(() => offerFor(leaky)).toThrow(OfferSecretLeakError);
	});

	it("names the offending path without echoing the value", () => {
		const offer = offerFor(inbox);
		const leaked: DeploymentOffer = {
			...offer,
			trustEvidenceRefs: ["Bearer sk_live_abcdefghijklmnop"],
		};
		try {
			assertOfferIsSecretFree(leaked);
			throw new Error("expected the scan to reject a bearer token");
		} catch (error) {
			expect(error).toBeInstanceOf(OfferSecretLeakError);
			// SAFETY: assertion to `error as OfferSecretLeakError` is required at this boundary.
			const failure = error as OfferSecretLeakError;
			expect(failure.path).toBe("offer.payload.trustEvidenceRefs[0]");
			expect(failure.message).not.toContain("sk_live_abcdefghijklmnop");
		}
	});
});

describe("acceptance binding", () => {
	it("binds a consent to the offer, topology, resolution, and catalog together", () => {
		const offer = offerFor(sqlApi);
		const acceptance = acceptOffer({
			offer,
			subjectRef: "guest/anonymous-1",
			acceptedAtMs: NOW + 1000,
			consents: [...offer.requiredConsents],
		});
		expect(acceptance.offerDigest).toBe(offerDigest(offer));
		expect(acceptance.topologyDigest).toBe(offer.topologyDigest);
		expect(acceptance.catalogDigest).toBe(offer.catalogDigest);
		expect(
			verifyAcceptance({
				acceptance,
				offer,
				catalogDigest: offer.catalogDigest,
				nowMs: NOW + 1000,
			}),
		).toEqual({ valid: true, reasons: [] });
	});

	it("invalidates a prior acceptance when the catalog digest moves", () => {
		const offer = offerFor(sqlApi);
		const acceptance = acceptOffer({
			offer,
			subjectRef: "guest/anonymous-1",
			acceptedAtMs: NOW + 1000,
			consents: [...offer.requiredConsents],
		});
		const verification = verifyAcceptance({
			acceptance,
			offer,
			catalogDigest:
				"sha256:1111111111111111111111111111111111111111111111111111111111111111",
			nowMs: NOW + 1000,
		});
		expect(verification.valid).toBe(false);
		expect(verification.reasons.map((reason) => reason.code)).toEqual([
			"CATALOG_DIGEST_MISMATCH",
		]);
		expect(verification.reasons[0]?.detail).toContain("requires a new consent");
	});

	it("invalidates an acceptance carried onto a different recipe's offer", () => {
		const original = offerFor(sqlApi);
		const substituted = offerFor(inbox);
		const acceptance = acceptOffer({
			offer: original,
			subjectRef: "guest/anonymous-1",
			acceptedAtMs: NOW + 1000,
			consents: [...original.requiredConsents],
		});
		const verification = verifyAcceptance({
			acceptance,
			offer: substituted,
			catalogDigest: substituted.catalogDigest,
			nowMs: NOW + 1000,
		});
		expect(verification.valid).toBe(false);
		expect(verification.reasons.map((reason) => reason.code)).toEqual([
			"OFFER_DIGEST_MISMATCH",
			"OFFER_ID_MISMATCH",
			"RESOLUTION_DIGEST_MISMATCH",
			"TOPOLOGY_DIGEST_MISMATCH",
		]);
	});

	it("rejects an expired offer and a missing consent", () => {
		const offer = offerFor(inbox);
		const acceptance = acceptOffer({
			offer,
			subjectRef: "guest/anonymous-1",
			acceptedAtMs: NOW + 1000,
			consents: [],
		});
		const verification = verifyAcceptance({
			acceptance,
			offer,
			catalogDigest: offer.catalogDigest,
			nowMs: offer.expiresAtMs,
		});
		expect(verification.valid).toBe(false);
		expect(new Set(verification.reasons.map((reason) => reason.code))).toEqual(
			new Set(["CONSENT_MISSING", "OFFER_EXPIRED"]),
		);
	});

	it("detects a tampered acceptance record", () => {
		const offer = offerFor(inbox);
		const acceptance = acceptOffer({
			offer,
			subjectRef: "guest/anonymous-1",
			acceptedAtMs: NOW + 1000,
			consents: [...offer.requiredConsents],
		});
		const verification = verifyAcceptance({
			acceptance: { ...acceptance, subjectRef: "guest/someone-else" },
			offer,
			catalogDigest: offer.catalogDigest,
			nowMs: NOW + 1000,
		});
		expect(verification.valid).toBe(false);
		expect(verification.reasons.map((reason) => reason.code)).toEqual([
			"ACCEPTANCE_DIGEST_MISMATCH",
		]);
	});
});
