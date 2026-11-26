/**
 * Derive the Examples console's claim terms from the shipped recipes.
 *
 * This is the only place the site is allowed to learn what a deploy commits a
 * visitor to. Every field below is read off a `SolutionRecipe` in
 * `@hobo/recipes`; none of it is written here, so the console cannot describe
 * a deployment in friendlier terms than the compiler will enforce.
 *
 * Node-only: `generate-recipe-terms.mts` runs it at build time and the browser
 * reads the JSON it wrote. Keeping the derivation out of the bundle is what
 * lets the console stay a static page.
 */
import {
	type SolutionRecipe,
	STANDARD_SOLUTION_RECIPES,
} from "@hobo/recipes";

export const RECIPE_TERMS_SCHEMA = "hobo.site.recipe-terms/v1";

export type RecipePlacementTerm = {
	readonly placementId: string;
	readonly primitive: string;
	readonly capabilityRef: string;
	readonly profileId: string;
	readonly productDefinitionId: string;
	/** Absent when the recipe leaves the runtime to Matching. */
	readonly runtimeModel: string | null;
	readonly claimMode: string;
	readonly claimActionCount: number;
	readonly claimDeadlineMsFromStart: number | null;
	readonly creatorAuthorityAfterClaim: string;
};

export type RecipeTerm = {
	readonly recipeId: string;
	readonly displayName: string;
	readonly description: string;
	readonly providerIds: readonly string[];
	readonly primitives: readonly string[];
	/** Ownership ceremonies the human inherits, summed across placements. */
	readonly claimActionCount: number;
	/** Soonest a placement is reaped if nobody claims it, in ms from deploy. */
	readonly earliestClaimDeadlineMs: number | null;
	readonly claimKind: string;
	readonly persistence: string;
	readonly realtime: string;
	readonly credentialCustody: string;
	readonly bootstrapFunding: string;
	readonly bootstrapClasses: readonly string[];
	readonly cleanupPolicies: readonly string[];
	readonly sponsoredCostCapMinorUnits: number;
	readonly sourceDisclosure: string;
	readonly requiredConsents: readonly string[];
	readonly offerTtlMs: number;
	readonly placements: readonly RecipePlacementTerm[];
};

export type RecipeTermsArtifact = {
	readonly schema: typeof RECIPE_TERMS_SCHEMA;
	readonly recipes: readonly RecipeTerm[];
};

function unique(values: readonly string[]): readonly string[] {
	return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function termsFor(recipe: SolutionRecipe): RecipeTerm {
	const deadlines = recipe.placements
		.map((placement) => placement.claim.deadlineMsFromStart)
		.filter((value): value is number => Number.isFinite(value));

	return {
		recipeId: recipe.id,
		displayName: recipe.displayName,
		description: recipe.description,
		providerIds: unique(recipe.yards.map((yard) => yard.providerId)),
		primitives: unique(recipe.placements.map((placement) => placement.primitive)),
		claimActionCount: recipe.placements.reduce(
			(total, placement) => total + placement.claim.actionCount,
			0,
		),
		earliestClaimDeadlineMs:
			deadlines.length === 0 ? null : Math.min(...deadlines),
		claimKind: recipe.delivers.claimKind,
		persistence: recipe.delivers.persistence,
		realtime: recipe.delivers.realtime,
		credentialCustody: recipe.delivers.credentialCustody,
		bootstrapFunding: recipe.delivers.bootstrap,
		bootstrapClasses: unique(recipe.yards.map((yard) => yard.lease.bootstrapClass)),
		cleanupPolicies: unique(recipe.yards.map((yard) => yard.lease.cleanupPolicy)),
		sponsoredCostCapMinorUnits: recipe.bootstrap.sponsoredCostCapMinorUnits,
		sourceDisclosure: recipe.bootstrap.sourceDisclosure,
		requiredConsents: [...recipe.bootstrap.requiredConsents],
		offerTtlMs: recipe.bootstrap.offerTtlMs,
		placements: recipe.placements.map((placement) => ({
			placementId: placement.placementId,
			primitive: placement.primitive,
			capabilityRef: placement.capabilityRef,
			profileId: placement.satisfiesProfileId,
			productDefinitionId: placement.productDefinitionId,
			runtimeModel: placement.runtimeModel ?? null,
			claimMode: placement.claim.mode,
			claimActionCount: placement.claim.actionCount,
			claimDeadlineMsFromStart: placement.claim.deadlineMsFromStart ?? null,
			creatorAuthorityAfterClaim: placement.claim.creatorAuthorityAfterClaim,
		})),
	};
}

export function deriveRecipeTerms(): RecipeTermsArtifact {
	return {
		schema: RECIPE_TERMS_SCHEMA,
		recipes: [...STANDARD_SOLUTION_RECIPES]
			.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
			.map(termsFor),
	};
}
