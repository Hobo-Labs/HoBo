/**
 * Claim terms, as the Examples console reads them.
 *
 * The artifact is generated from `@hobo/recipes` at build time
 * (`generate-recipe-terms.mts`) and drift-gated by `recipe-terms.test.ts`, so
 * this module parses rather than describes: it turns the JSON into the shape
 * the console renders and picks the recipes that fit the app in hand.
 *
 * Browser-safe. No Node imports, no recipe compiler in the bundle.
 */
import artifact from "./recipe-terms.json" with { type: "json" };
import type {
	RecipeTerm,
	RecipeTermsArtifact,
} from "./recipe-terms-source.js";

export type { RecipePlacementTerm, RecipeTerm } from "./recipe-terms-source.js";

export const RECIPE_TERMS: readonly RecipeTerm[] = Object.freeze(
	// SAFETY: generate-recipe-terms writes RecipeTermsArtifact JSON consumed here.
	(artifact as RecipeTermsArtifact).recipes,
);

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** "24h", "45m" — a deadline a visitor can read without doing arithmetic. */
export function formatDeadline(ms: number | null): string {
	if (ms === null) return "no deadline";
	if (ms >= HOUR_MS) {
		const hours = ms / HOUR_MS;
		return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
	}
	const minutes = Math.max(1, Math.round(ms / MINUTE_MS));
	return `${minutes}m`;
}

/**
 * Recipes that cover every primitive an app declares.
 *
 * Superset, not intersection: a recipe that places a database an app never
 * asked for would provision something the visitor did not request, and one
 * that covers only half the app is not a deployment.
 */
export function recipesForPrimitives(
	primitives: readonly string[],
): readonly RecipeTerm[] {
	if (primitives.length === 0) return [];
	const wanted = new Set(primitives);
	return RECIPE_TERMS.filter((term) => {
		const covered = new Set(term.primitives);
		for (const primitive of wanted) {
			if (!covered.has(primitive)) return false;
		}
		return true;
	});
}

/** One line summarising what the visitor takes on, for the collapsed view. */
export function summarizeTerms(term: RecipeTerm): string {
	const claims =
		term.claimActionCount === 1
			? "1 claim action"
			: `${term.claimActionCount} claim actions`;
	const deadline = formatDeadline(term.earliestClaimDeadlineMs);
	const funding =
		term.bootstrapFunding === "sponsored"
			? `sponsored up to ${term.sponsoredCostCapMinorUnits} minor units`
			: "on the provider's free tier";
	return `${term.providerIds.join(" + ")} · ${claims} within ${deadline} · ${funding}`;
}
