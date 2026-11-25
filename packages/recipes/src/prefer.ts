import type {
	RecipeCompilation,
	RecipeCompilationAccepted,
} from "./compile.js";
import { type CompileRecipeInput, compileRecipe } from "./compile.js";
import type { RecipeId } from "./ids.js";
import type { SolutionRecipe } from "./recipe.js";

export type RecipeCandidateOutcome = {
	readonly recipeId: RecipeId;
	readonly compilation: RecipeCompilation;
};

export type RankedRecipe = {
	readonly recipe: SolutionRecipe;
	readonly compilation: RecipeCompilationAccepted;
};

export type RecipeChoice = {
	readonly winner?: RankedRecipe;
	readonly ranked: readonly RankedRecipe[];
	readonly outcomes: readonly RecipeCandidateOutcome[];
};

export type ChooseRecipeInput = Omit<CompileRecipeInput, "recipe"> & {
	readonly candidates: readonly SolutionRecipe[];
};

const ATOMICITY_RANK = {
	"single-resource": 0,
	"provider-bundled": 1,
	"best-effort-saga": 2,
} as const;

function providerCount(ranked: RankedRecipe): number {
	return new Set(
		ranked.compilation.topology.yards.map((yard) => yard.providerId),
	).size;
}

function compare(a: RankedRecipe, b: RankedRecipe): number {
	const providers = providerCount(a) - providerCount(b);
	if (providers !== 0) return providers;

	const claims =
		a.compilation.claims.items.length - b.compilation.claims.items.length;
	if (claims !== 0) return claims;
	const actions =
		a.compilation.claims.actionCount - b.compilation.claims.actionCount;
	if (actions !== 0) return actions;

	const degradations =
		a.compilation.widenings.length - b.compilation.widenings.length;
	if (degradations !== 0) return degradations;

	const atomicity =
		(ATOMICITY_RANK[a.compilation.claims.atomicity] ?? 3) -
		(ATOMICITY_RANK[b.compilation.claims.atomicity] ?? 3);
	if (atomicity !== 0) return atomicity;

	const cost =
		a.compilation.sponsoredCostMinorUnits -
		b.compilation.sponsoredCostMinorUnits;
	if (cost !== 0) return cost;
	const exportGap =
		a.compilation.portability.exportMissingPlacements.length -
		b.compilation.portability.exportMissingPlacements.length;
	if (exportGap !== 0) return exportGap;

	return a.recipe.id.localeCompare(b.recipe.id);
}

export function chooseRecipe(input: ChooseRecipeInput): RecipeChoice {
	const { candidates, ...shared } = input;
	const outcomes: RecipeCandidateOutcome[] = [];
	const ranked: RankedRecipe[] = [];

	for (const recipe of [...candidates].sort((a, b) =>
		a.id.localeCompare(b.id),
	)) {
		const compilation = compileRecipe({ ...shared, recipe });
		outcomes.push({ recipeId: recipe.id, compilation });
		if (compilation.ok) ranked.push({ recipe, compilation });
	}

	ranked.sort(compare);
	const winner = ranked[0];
	if (winner === undefined) {
		return { ranked, outcomes };
	}
	return { winner, ranked, outcomes };
}
