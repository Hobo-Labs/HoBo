/**
 * The three sponsored product definitions.
 *
 * `sponsored-transfer.ts` owns the *strategy* — one transfer ceremony. These are
 * the *products* the catalog selects over, and the properties asserted here are
 * the ones a reader of an offer would be misled by if they were wrong: who pays,
 * how many human actions a claim costs, and whether the word "anonymous" ever
 * attaches to Vercel.
 */
import {
	createCapabilityProfileRegistry,
	DEFAULT_TRUST_POLICY,
	parseCapabilityRequirement,
	STANDARD_CAPABILITY_PROFILES,
	selectCapabilityImplementation,
} from "@hobo/capability-profiles";
import { describe, expect, it } from "vitest";

import {
	createVercelClaimDeploymentDefinition,
	createVercelSponsoredWebDefinition,
	semanticsToSelectionCandidate,
	VERCEL_BOOTSTRAP_STRATEGY_REF,
	VERCEL_CLAIM_DEPLOYMENT_DEFINITION_ID,
	VERCEL_CLAIM_STRATEGY_REF,
	VERCEL_EVIDENCE_CHECKED_AT,
	VERCEL_SOURCE_REFS,
	VERCEL_SPONSORED_API_DEFINITION_ID,
	VERCEL_SPONSORED_CANDIDATES,
	VERCEL_SPONSORED_DEFINITIONS,
	VERCEL_SPONSORED_WEB_DEFINITION_ID,
} from "../src/index.js";

describe("the sponsored Vercel product definitions", () => {
	it("declares the three product ids on one transfer strategy", () => {
		expect(
			VERCEL_SPONSORED_DEFINITIONS.map((definition) => definition.id),
		).toEqual([
			VERCEL_SPONSORED_WEB_DEFINITION_ID,
			VERCEL_SPONSORED_API_DEFINITION_ID,
			VERCEL_CLAIM_DEPLOYMENT_DEFINITION_ID,
		]);
		for (const definition of VERCEL_SPONSORED_DEFINITIONS) {
			expect(definition.providerId).toBe("vercel");
			expect(definition.semantics.bootstrapStrategyRef).toBe(
				"bootstrap.vercel.sponsored/v1",
			);
			expect(definition.semantics.claimStrategyRef).toBe(
				"vercel.sponsored-project-transfer/v1",
			);
		}
		expect(VERCEL_BOOTSTRAP_STRATEGY_REF).toBe("bootstrap.vercel.sponsored/v1");
		expect(VERCEL_CLAIM_STRATEGY_REF).toBe(
			"vercel.sponsored-project-transfer/v1",
		);
	});

	it("states that HoBo pays, on every product", () => {
		for (const definition of VERCEL_SPONSORED_DEFINITIONS) {
			expect(definition.semantics.sponsorExposureMinorUnits).toBeGreaterThan(0);
			expect(definition.semantics.structuredCapabilities.bootstrap).toBe(
				"sponsor-backed",
			);
			expect(
				definition.semantics.structuredCapabilities.sponsorOwnsProviderAccount,
			).toBe(true);
			expect(
				definition.semantics.structuredCapabilities.anonymousDeployment,
			).toBe(false);
		}
	});

	it("never describes Vercel as anonymous in any serialized string", () => {
		const serialized = JSON.stringify(VERCEL_SPONSORED_DEFINITIONS);
		// The only permitted occurrence is the explicit denial.
		expect(serialized).toContain('"anonymousDeployment":false');
		expect(/"[^"]*anonymous[^"]*"\s*:\s*true/iu.test(serialized)).toBe(false);
	});

	it("charges the claim-deployment product a second human action", () => {
		const web = createVercelSponsoredWebDefinition();
		const claim = createVercelClaimDeploymentDefinition();
		expect(web.semantics.claimActionCount).toBe(1);
		expect(web.semantics.continuity.credentials).toBe("revoked");
		// The database credential minted before the claim survives the transfer,
		// so it is rotated rather than revoked — and that costs an extra action.
		expect(claim.semantics.claimActionCount).toBe(2);
		expect(claim.semantics.continuity.credentials).toBe("rotated");
		expect(claim.semantics.producesBindingProfiles).toContain(
			"binding.postgresql/v1",
		);
	});

	it("carries a source URL and the date it was checked", () => {
		expect(VERCEL_EVIDENCE_CHECKED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
		expect(VERCEL_SOURCE_REFS.length).toBeGreaterThan(0);
		for (const source of VERCEL_SOURCE_REFS) {
			expect(source.url.startsWith("https://vercel.com/docs/")).toBe(true);
			expect(source.checkedAt).toBe(VERCEL_EVIDENCE_CHECKED_AT);
			expect(source.note.length).toBeGreaterThan(0);
		}
	});

	it("projects to selection candidates that a sponsor-funded policy can pick", () => {
		expect(VERCEL_SPONSORED_CANDIDATES).toHaveLength(
			VERCEL_SPONSORED_DEFINITIONS.length,
		);
		const requirement = parseCapabilityRequirement({
			requiredProfiles: [{ profileId: "web.static/v1", versionRange: ">=1" }],
		});
		const nowMs = Date.parse(`${VERCEL_EVIDENCE_CHECKED_AT}T00:00:00Z`);
		const funded = selectCapabilityImplementation({
			requirement,
			registry: createCapabilityProfileRegistry(STANDARD_CAPABILITY_PROFILES),
			candidates: [
				semanticsToSelectionCandidate(createVercelSponsoredWebDefinition()),
			],
			policy: {
				...DEFAULT_TRUST_POLICY,
				maximumEvidenceAgeMs: 365 * 24 * 60 * 60 * 1000,
				sponsorBudgetMinorUnits: 10_000,
			},
			nowMs,
		});
		expect(funded.winner?.definitionId).toBe(
			VERCEL_SPONSORED_WEB_DEFINITION_ID,
		);
	});

	it("is unselectable under the default zero sponsor budget", () => {
		const requirement = parseCapabilityRequirement({
			requiredProfiles: [{ profileId: "web.static/v1", versionRange: ">=1" }],
		});
		const nowMs = Date.parse(`${VERCEL_EVIDENCE_CHECKED_AT}T00:00:00Z`);
		const unfunded = selectCapabilityImplementation({
			requirement,
			registry: createCapabilityProfileRegistry(STANDARD_CAPABILITY_PROFILES),
			candidates: [
				semanticsToSelectionCandidate(createVercelSponsoredWebDefinition()),
			],
			policy: {
				...DEFAULT_TRUST_POLICY,
				maximumEvidenceAgeMs: 365 * 24 * 60 * 60 * 1000,
			},
			nowMs,
		});
		expect(unfunded.winner).toBeUndefined();
		expect(unfunded.rejections.length).toBeGreaterThan(0);
	});
});
