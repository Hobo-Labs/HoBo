/**
 * Preference only ever orders survivors.
 *
 * Compatibility is settled by the gates first; nothing in here can rescue an
 * incompatible recipe or let a cheaper provider buy its way past a refusal.
 */
import { describe, expect, it } from "vitest";

import {
	chooseRecipe,
	findStandardRecipe,
	parseDeploymentRequest,
	parseSolutionRecipe,
	type SolutionRecipe,
} from "../src/index.js";
import {
	CATALOG,
	CHEAP_INCOMPATIBLE_CANDIDATE,
	capabilityFor,
	catalogDigestOf,
	connectivity,
	EVIDENCE,
	NOW,
	policyWith,
	registry,
	requestForRecipe,
	TRUST_REQUIREMENT,
	VERIFIER,
} from "./fixtures.js";

function requireRecipe(id: string): SolutionRecipe {
	const recipe = findStandardRecipe(id);
	if (recipe === undefined) throw new Error(`missing fixture recipe ${id}`);
	return recipe;
}

const neonSandbox = requireRecipe("recipe.neon.claimable-sql-sandbox/v1");
const prismaSandbox = requireRecipe("recipe.prisma.claimable-sql-sandbox/v1");
const netlifyReport = requireRecipe(
	"recipe.netlify.claimable-generated-report/v1",
);
const cloudflareReport = requireRecipe(
	"recipe.cloudflare.claimable-generated-report/v1",
);
const polyglot = requireRecipe(
	"recipe.cloudflare-neon-upstash.polyglot-saas/v1",
);

const DAY = 24 * 60 * 60 * 1000;

/** The same ask as the polyglot recipe, answered across two providers. */
const twoProviderSaas = parseSolutionRecipe({
	schemaVersion: "hobo.solution-recipe/v1",
	id: "recipe.test.cloudflare-neon.sufficient-saas/v1",
	displayName: "Sufficient SaaS",
	description:
		"Two Yards where the polyglot recipe uses three. Semantically identical for this request.",
	yards: [
		{
			yardId: "edge",
			providerId: "cloudflare",
			resourceOnly: false,
			sponsored: false,
			lease: {
				bootstrapClass: "anonymous-claimable",
				cleanupPolicy: "delete",
				renewable: false,
				claimByMsFromStart: DAY,
			},
		},
		{
			yardId: "data",
			providerId: "neon",
			resourceOnly: true,
			sponsored: false,
			lease: {
				bootstrapClass: "anonymous-claimable",
				cleanupPolicy: "retain-until-provider-expiry",
				renewable: false,
				claimByMsFromStart: DAY,
			},
		},
	],
	placements: [
		{
			placementId: "api",
			yardId: "edge",
			campId: "app",
			primitive: "api",
			capabilityRef: "api",
			satisfiesProfileId: "api.http/v1",
			productDefinitionId: "cloudflare.temporary-workers-api/v1",
			runtimeModel: "serverless_faas",
			claim: {
				mode: "account-claim",
				atomicity: "single-resource",
				actionCount: 1,
				deadlineMsFromStart: DAY,
				creatorAuthorityAfterClaim: "rotatable",
			},
		},
		{
			placementId: "board",
			yardId: "edge",
			campId: "app",
			primitive: "kv",
			capabilityRef: "board",
			satisfiesProfileId: "kv.key-value/v1",
			productDefinitionId: "cloudflare.temporary-kv/v1",
			claim: {
				mode: "none",
				atomicity: "single-resource",
				actionCount: 0,
				creatorAuthorityAfterClaim: "absent",
			},
		},
		{
			placementId: "db",
			yardId: "data",
			primitive: "data",
			capabilityRef: "db",
			satisfiesProfileId: "data.postgres/v1",
			productDefinitionId: "neon.claimable-postgres/v1",
			claim: {
				mode: "resource-claim",
				atomicity: "single-resource",
				actionCount: 1,
				deadlineMsFromStart: DAY,
				creatorAuthorityAfterClaim: "rotatable",
			},
		},
	],
	edges: [
		{
			edgeId: "api-db",
			fromPlacementId: "api",
			toPlacementId: "db",
			primary: {
				connectivityImplementationId: "cloudflare.postgres.hyperdrive/v1",
				bindingProfileRef: "binding.postgresql/v1",
			},
		},
	],
	delivers: {
		claimCount: 2,
		claimKind: "provider-native",
		persistence: "persistent",
		realtime: "none",
		credentialCustody: "secret-ref",
		bootstrap: "public-anonymous",
	},
	bootstrap: {
		sponsoredCostCapMinorUnits: 0,
		sourceDisclosure: "public-source",
		requiredConsents: ["claim.deadline-understood"],
		offerTtlMs: 15 * 60 * 1000,
	},
});

const saasRequest = parseDeploymentRequest({
	deploymentRef: "junction/saas",
	capabilities: [
		capabilityFor("api", "api.http/v1", {
			runtime: { allowed: ["serverless_faas"] },
		}),
		capabilityFor("board", "kv.key-value/v1"),
		capabilityFor("db", "data.postgres/v1"),
	],
	dependencies: [
		{ fromCapabilityRef: "api", toCapabilityRef: "board" },
		{ fromCapabilityRef: "api", toCapabilityRef: "db" },
	],
	requestedSemantics: {
		claimCount: 3,
		claimKind: "provider-native",
		persistence: "persistent",
		realtime: "polling",
		credentialCustody: "secret-ref",
		bootstrap: "public-anonymous",
	},
});

const shared = {
	registry,
	catalog: CATALOG,
	catalogDigest: catalogDigestOf(CATALOG),
	connectivity,
	trustRequirement: TRUST_REQUIREMENT,
	evidence: EVIDENCE,
	verifier: VERIFIER,
	nowMs: NOW,
};

describe("chooseRecipe", () => {
	it("prefers the fewest provider boundaries that preserve the semantics", () => {
		const choice = chooseRecipe({
			...shared,
			request: saasRequest,
			policy: policyWith({ maximumProviderCount: 3, maximumClaimActions: 3 }),
			candidates: [polyglot, twoProviderSaas],
		});
		expect(choice.ranked).toHaveLength(2);
		expect(choice.winner?.recipe.id).toBe(
			"recipe.test.cloudflare-neon.sufficient-saas/v1",
		);
		// The advanced recipe is compatible — it simply costs more boundaries.
		expect(choice.ranked[1]?.recipe.id).toBe(polyglot.id);
	});

	it("does not let declaration order decide the winner", () => {
		const forward = chooseRecipe({
			...shared,
			request: saasRequest,
			policy: policyWith({ maximumProviderCount: 3, maximumClaimActions: 3 }),
			candidates: [polyglot, twoProviderSaas],
		});
		const reversed = chooseRecipe({
			...shared,
			request: saasRequest,
			policy: policyWith({ maximumProviderCount: 3, maximumClaimActions: 3 }),
			candidates: [twoProviderSaas, polyglot],
		});
		expect(reversed.winner?.recipe.id).toBe(forward.winner?.recipe.id);
		expect(reversed.ranked.map((entry) => entry.recipe.id)).toEqual(
			forward.ranked.map((entry) => entry.recipe.id),
		);
	});

	it("resolves one provider-neutral Postgres ask onto either product, deterministically", () => {
		const request = parseDeploymentRequest({
			deploymentRef: "junction/sandbox",
			capabilities: [capabilityFor("db", "data.postgres/v1")],
			requestedSemantics: neonSandbox.delivers,
		});
		const choice = chooseRecipe({
			...shared,
			request,
			policy: policyWith(),
			candidates: [prismaSandbox, neonSandbox],
		});
		expect(choice.ranked.map((entry) => entry.recipe.id)).toEqual([
			"recipe.neon.claimable-sql-sandbox/v1",
			"recipe.prisma.claimable-sql-sandbox/v1",
		]);
		expect(choice.outcomes.every((outcome) => outcome.compilation.ok)).toBe(
			true,
		);
	});

	it("resolves one provider-neutral static ask onto either host", () => {
		const request = parseDeploymentRequest({
			deploymentRef: "junction/report",
			capabilities: [
				// Provider-neutral means neutral about the runtime too: Cloudflare
				// serves the report from a Worker, Netlify from static hosting,
				// and the ask should not silently exclude one of them.
				capabilityFor("site", "web.static/v1", {
					runtime: { allowed: ["serverless_faas", "paas"] },
				}),
			],
			requestedSemantics: netlifyReport.delivers,
		});
		const choice = chooseRecipe({
			...shared,
			request,
			policy: policyWith(),
			candidates: [netlifyReport, cloudflareReport],
		});
		expect(choice.ranked).toHaveLength(2);
		expect(choice.winner?.recipe.id).toBe(
			"recipe.cloudflare.claimable-generated-report/v1",
		);
	});

	it("never lets a cheaper incompatible provider change the outcome", () => {
		const bargainSandbox = parseSolutionRecipe({
			...neonSandbox,
			id: "recipe.test.bargain.claimable-sql-sandbox/v1",
			yards: neonSandbox.yards.map((yard) => ({
				...yard,
				providerId: "bargain",
			})),
			placements: neonSandbox.placements.map((placement) => ({
				...placement,
				productDefinitionId: "bargain.postgres/v1",
			})),
		});
		const catalog = [...CATALOG, CHEAP_INCOMPATIBLE_CANDIDATE];
		const request = parseDeploymentRequest({
			deploymentRef: "junction/sandbox",
			capabilities: [capabilityFor("db", "data.postgres/v1")],
			requestedSemantics: neonSandbox.delivers,
		});

		const without = chooseRecipe({
			...shared,
			request,
			policy: policyWith(),
			candidates: [neonSandbox],
		});
		const with_ = chooseRecipe({
			...shared,
			request,
			catalog,
			catalogDigest: catalogDigestOf(catalog),
			policy: policyWith(),
			candidates: [neonSandbox, bargainSandbox],
		});

		expect(with_.winner?.recipe.id).toBe(
			"recipe.neon.claimable-sql-sandbox/v1",
		);
		expect(with_.winner?.compilation.resolutionDigest).toBe(
			without.winner?.compilation.resolutionDigest,
		);
		const bargain = with_.outcomes.find(
			(outcome) => outcome.recipeId === bargainSandbox.id,
		);
		expect(bargain?.compilation.ok).toBe(false);
		expect(
			bargain?.compilation.rejections.map((rejection) => rejection.code),
		).toContain("PROVIDER_MATURITY_DENIED");
	});

	it("reports every candidate's outcome, not only the survivors", () => {
		const choice = chooseRecipe({
			...shared,
			request: requestForRecipe(neonSandbox),
			policy: policyWith(),
			candidates: [neonSandbox, prismaSandbox],
		});
		expect(choice.outcomes.map((outcome) => outcome.recipeId)).toEqual([
			"recipe.neon.claimable-sql-sandbox/v1",
			"recipe.prisma.claimable-sql-sandbox/v1",
		]);
	});

	it("returns no winner when nothing is compatible", () => {
		const request = parseDeploymentRequest({
			deploymentRef: "junction/impossible",
			capabilities: [capabilityFor("db", "data.graph/v1")],
			requestedSemantics: neonSandbox.delivers,
		});
		const choice = chooseRecipe({
			...shared,
			request,
			policy: policyWith(),
			candidates: [neonSandbox, prismaSandbox],
		});
		expect(choice.winner).toBeUndefined();
		expect(choice.ranked).toEqual([]);
		expect(choice.outcomes).toHaveLength(2);
	});
});
