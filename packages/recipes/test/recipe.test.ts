import { describe, expect, it } from "vitest";

import {
	DEFAULT_RECIPE_POLICY,
	DeploymentRequestError,
	findStandardRecipe,
	parseDeploymentRequest,
	parseRecipeId,
	parseRecipePolicy,
	parseSolutionRecipe,
	RecipeIdError,
	RecipePolicyError,
	SolutionRecipeError,
	type SolutionRecipeInput,
	STANDARD_SOLUTION_RECIPES,
	tryParseRecipeId,
} from "../src/index.js";
import { capabilityFor } from "./fixtures.js";

function requireInput(id: string): SolutionRecipeInput {
	const recipe = findStandardRecipe(id);
	if (recipe === undefined) throw new Error(`missing fixture recipe ${id}`);
	return recipe;
}

const inbox = requireInput("recipe.cloudflare.claimable-webhook-inbox/v1");
const sandbox = requireInput("recipe.neon.claimable-sql-sandbox/v1");

describe("recipe ids", () => {
	it("parses a versioned slug", () => {
		const parsed = parseRecipeId(
			"recipe.cloudflare.claimable-webhook-inbox/v1",
		);
		expect(parsed.slug).toEqual(["cloudflare", "claimable-webhook-inbox"]);
		expect(parsed.major).toBe(1);
	});

	it("refuses ids that are not recipe-shaped", () => {
		for (const bad of [
			"cloudflare.inbox/v1",
			"recipe.Cloudflare.Inbox/v1",
			"recipe.inbox",
			"recipe.inbox/v0",
			"recipe./v1",
		]) {
			expect(() => parseRecipeId(bad)).toThrow(RecipeIdError);
			expect(tryParseRecipeId(bad)).toBeUndefined();
		}
	});
});

describe("parseSolutionRecipe", () => {
	it("orders yards, placements, and edges canonically", () => {
		const recipe = parseSolutionRecipe({
			...inbox,
			placements: [...inbox.placements].reverse(),
		});
		expect(recipe.placements.map((placement) => placement.placementId)).toEqual(
			["inbox", "log"],
		);
	});

	it("refuses a Camp inside a resource-only Yard", () => {
		expect(() =>
			parseSolutionRecipe({
				...sandbox,
				placements: sandbox.placements.map((placement) => ({
					...placement,
					campId: "app",
				})),
			}),
		).toThrow(/names a camp inside resource-only yard/u);
	});

	it("refuses a workload placement with no Camp to live in", () => {
		expect(() =>
			parseSolutionRecipe({
				...inbox,
				placements: inbox.placements.map(
					({ campId: _campId, ...placement }) => placement,
				),
			}),
		).toThrow(/needs a camp/u);
	});

	it("refuses two placements covering one capability", () => {
		expect(() =>
			parseSolutionRecipe({
				...inbox,
				placements: [
					...inbox.placements,
					{ ...inbox.placements[0], placementId: "inbox-2" },
				],
			} as SolutionRecipeInput),
		).toThrow(/covered by more than one placement/u);
	});

	it("refuses a profile that does not match the placement primitive", () => {
		expect(() =>
			parseSolutionRecipe({
				...sandbox,
				placements: sandbox.placements.map((placement) => ({
					...placement,
					satisfiesProfileId: "api.http/v1",
				})),
			}),
		).toThrow(/is not a data profile/u);
	});

	it("refuses human actions on an ownership transition of none", () => {
		expect(() =>
			parseSolutionRecipe({
				...inbox,
				placements: inbox.placements.map((placement) =>
					placement.claim.mode === "none"
						? { ...placement, claim: { ...placement.claim, actionCount: 1 } }
						: placement,
				),
			}),
		).toThrow(/claim actions for an ownership transition of "none"/u);
	});

	it("refuses a delivered claim count the placements do not back", () => {
		expect(() =>
			parseSolutionRecipe({
				...inbox,
				delivers: { ...inbox.delivers, claimCount: 2 },
			}),
		).toThrow(/but 1 placements carry an ownership transition/u);
	});

	it("refuses a sponsored Yard that promises a public-anonymous bootstrap", () => {
		expect(() =>
			parseSolutionRecipe({
				...inbox,
				yards: inbox.yards.map((yard) => ({ ...yard, sponsored: true })),
			}),
		).toThrow(/sponsored yard but promises a public-anonymous bootstrap/u);
	});

	it("refuses an edge that connects a placement to itself", () => {
		expect(() =>
			parseSolutionRecipe({
				...inbox,
				edges: [
					{
						edgeId: "self",
						fromPlacementId: "inbox",
						toPlacementId: "inbox",
						primary: {
							connectivityImplementationId: "wasm.wasi-config-binding/v1",
							bindingProfileRef: "binding.http/v1",
						},
					},
				],
			}),
		).toThrow(SolutionRecipeError);
	});
});

describe("the shipped catalog", () => {
	it("ships the twelve first-party recipes, ordered by id", () => {
		expect(STANDARD_SOLUTION_RECIPES.map((recipe) => recipe.id)).toEqual([
			"recipe.cloudflare-neon-upstash.polyglot-saas/v1",
			"recipe.cloudflare-neon.portable-sql-api/v1",
			"recipe.cloudflare-upstash.live-leaderboard/v1",
			"recipe.cloudflare.claimable-generated-report/v1",
			"recipe.cloudflare.claimable-webhook-inbox/v1",
			"recipe.convex-cloud.sponsored-transfer/v1",
			"recipe.convex.local-accountless-preview/v1",
			"recipe.convex.selfhosted-strong-claim/v1",
			"recipe.neon.claimable-sql-sandbox/v1",
			"recipe.netlify.claimable-generated-report/v1",
			"recipe.prisma.claimable-sql-sandbox/v1",
			"recipe.vercel-prisma.claimable-issue-tracker/v1",
		]);
	});

	it("never pins a provider inside a placement's capability slot", () => {
		for (const recipe of STANDARD_SOLUTION_RECIPES) {
			for (const placement of recipe.placements) {
				expect(placement.capabilityRef).not.toMatch(
					/(provider|vendor|account|tenant)/iu,
				);
			}
		}
	});

	it("answers the same provider-neutral Postgres requirement from two products", () => {
		const neon = requireInput("recipe.neon.claimable-sql-sandbox/v1");
		const prisma = requireInput("recipe.prisma.claimable-sql-sandbox/v1");
		expect(neon.placements[0]?.satisfiesProfileId).toBe("data.postgres/v1");
		expect(prisma.placements[0]?.satisfiesProfileId).toBe("data.postgres/v1");
		expect(neon.placements[0]?.productDefinitionId).not.toBe(
			prisma.placements[0]?.productDefinitionId,
		);
	});
});

describe("deployment requests", () => {
	it("refuses a capability slot that reaches for provider identity", () => {
		for (const capabilityRef of [
			"providerDb",
			"tenantStore",
			"vendorQueue",
			"accountKv",
		]) {
			expect(() =>
				parseDeploymentRequest({
					deploymentRef: "junction/x",
					capabilities: [capabilityFor(capabilityRef, "data.postgres/v1")],
					requestedSemantics: inbox.delivers,
				}),
			).toThrow(DeploymentRequestError);
		}
	});

	it("refuses a dependency onto a capability nobody declared", () => {
		expect(() =>
			parseDeploymentRequest({
				deploymentRef: "junction/x",
				capabilities: [capabilityFor("api", "api.http/v1")],
				dependencies: [{ fromCapabilityRef: "api", toCapabilityRef: "db" }],
				requestedSemantics: inbox.delivers,
			}),
		).toThrow(DeploymentRequestError);
	});
});

describe("recipe policy", () => {
	it("permits no widening by default", () => {
		expect(DEFAULT_RECIPE_POLICY.allowedWidenings).toEqual([]);
		expect(DEFAULT_RECIPE_POLICY.requireSourceDisclosure).toBe(true);
	});

	it("refuses an unknown widening kind", () => {
		expect(() =>
			parseRecipePolicy({
				maximumProviderCount: 1,
				maximumClaimActions: 1,
				maximumSponsoredCostMinorUnits: 0,
				minimumClaimWindowMs: 0,
				maximumEvidenceAgeMs: 1000,
				allowedWidenings: ["profile.made-up"] as never,
			}),
		).toThrow(RecipePolicyError);
	});

	it("refuses a policy that allows zero providers", () => {
		expect(() =>
			parseRecipePolicy({
				maximumProviderCount: 0,
				maximumClaimActions: 1,
				maximumSponsoredCostMinorUnits: 0,
				minimumClaimWindowMs: 0,
				maximumEvidenceAgeMs: 1000,
			}),
		).toThrow(RecipePolicyError);
	});
});
