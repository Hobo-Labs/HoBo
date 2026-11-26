/**
 * What a visitor takes on when they press Deploy.
 *
 * The console has always shown where an app lands. It has not shown what the
 * visitor inherits: how many ownership ceremonies the deployment leaves behind,
 * how long they have before the provider reaps it, who holds the credentials
 * until then, and who is paying. Those terms exist as data on the shipped
 * recipes, so the console reads them rather than restating them.
 *
 * The primitives an app needs are read off the app's own runtime descriptor —
 * the resources it declares and whether it serves routes — so an app that
 * grows a queue stops matching a recipe that cannot place one, without anyone
 * editing a table.
 */
import type { ExampleCatalogEntry } from "./catalog-contract.js";
import {
	formatDeadline,
	type RecipeTerm,
	recipesForPrimitives,
	summarizeTerms,
} from "./recipe-terms.js";

export { formatDeadline, summarizeTerms };
export type { RecipeTerm };

/**
 * The Bindle primitives an example declares.
 *
 * `api` comes from serving routes at all; the rest come from the resources the
 * app asked for. Deliberately no default: an app that declares nothing matches
 * no recipe, rather than matching the least demanding one.
 */
export function primitivesForExample(
	example: ExampleCatalogEntry,
): readonly string[] {
	const primitives = new Set<string>();
	for (const resource of Object.values(example.runtime.resources)) {
		primitives.add(resource.kind);
	}
	if (example.runtime.routes.length > 0) primitives.add("api");
	return [...primitives].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Recipes that could deploy this app, best terms first. */
export function recipesForExample(
	example: ExampleCatalogEntry,
): readonly RecipeTerm[] {
	return [...recipesForPrimitives(primitivesForExample(example))].sort(
		compareByTerms,
	);
}

/**
 * Rank by what it costs the visitor, not by what it offers HoBo.
 *
 * Fewer ownership ceremonies first, then a longer deadline (more time to
 * complete them), then unsponsored before sponsored — an unsponsored
 * deployment owes nobody anything. Ties break on the id so the order is
 * stable across reloads.
 */
export function compareByTerms(a: RecipeTerm, b: RecipeTerm): number {
	if (a.claimActionCount !== b.claimActionCount) {
		return a.claimActionCount - b.claimActionCount;
	}
	const deadlineOf = (term: RecipeTerm) =>
		term.earliestClaimDeadlineMs ?? Number.POSITIVE_INFINITY;
	if (deadlineOf(a) !== deadlineOf(b)) return deadlineOf(b) - deadlineOf(a);
	if (a.sponsoredCostCapMinorUnits !== b.sponsoredCostCapMinorUnits) {
		return a.sponsoredCostCapMinorUnits - b.sponsoredCostCapMinorUnits;
	}
	return a.recipeId < b.recipeId ? -1 : a.recipeId > b.recipeId ? 1 : 0;
}

export type TermsRow = readonly [label: string, value: string];

/** The disclosure rows, in the order a visitor needs to read them. */
export function termsRows(term: RecipeTerm): readonly TermsRow[] {
	return [
		["providers", term.providerIds.join(", ")],
		[
			"claim actions",
			term.claimActionCount === 0
				? "none — nothing leaves this machine"
				: String(term.claimActionCount),
		],
		["claim deadline", formatDeadline(term.earliestClaimDeadlineMs)],
		["if unclaimed", term.cleanupPolicies.join(", ")],
		["credentials", term.credentialCustody],
		["state", term.persistence],
		[
			"paid by",
			term.bootstrapFunding === "sponsored"
				? `HoBo, capped at ${term.sponsoredCostCapMinorUnits} minor units`
				: "the provider's free tier",
		],
		["source", term.sourceDisclosure],
		[
			"you consent to",
			term.requiredConsents.length === 0
				? "nothing — no ownership changes hands"
				: term.requiredConsents.join(", "),
		],
	];
}
