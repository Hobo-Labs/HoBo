/**
 * Recipe identity.
 *
 * A recipe id is `recipe.<slug>/v<major>` where the slug names the providers
 * and the solution, e.g. `recipe.cloudflare-neon.portable-sql-api/v1`. The
 * provider names live in the *recipe* id, never in a Bindle: that is the whole
 * point of the split.
 */

declare const recipeIdBrand: unique symbol;

/** A parsed recipe id. Construct only through {@link parseRecipeId}. */
export type RecipeId = string & { readonly [recipeIdBrand]: "RecipeId" };

export type ParsedRecipeId = {
	readonly id: RecipeId;
	/** Dot-separated segments after the `recipe.` prefix. */
	readonly slug: readonly string[];
	readonly major: number;
};

export class RecipeIdError extends Error {
	readonly code = "INVALID_RECIPE_ID" as const;
	readonly input: string;

	constructor(input: string, detail: string) {
		super(`invalid recipe id ${JSON.stringify(input)}: ${detail}`);
		this.name = "RecipeIdError";
		this.input = input;
	}
}

const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function parseRecipeId(input: string): ParsedRecipeId {
	if (
		Object.prototype.toString.call(input) !== "[object String]" ||
		input.length === 0
	) {
		throw new RecipeIdError(String(input), "must be a non-empty string");
	}
	if (input !== input.trim()) {
		throw new RecipeIdError(input, "must not have leading/trailing whitespace");
	}
	if (input !== input.toLowerCase()) {
		throw new RecipeIdError(input, "must be lowercase (canonical form)");
	}
	const slash = input.lastIndexOf("/");
	if (slash <= 0 || slash === input.length - 1) {
		throw new RecipeIdError(input, "must end with /v<major>");
	}
	const versionMatch = /^v([1-9][0-9]*)$/u.exec(input.slice(slash + 1));
	if (!versionMatch) {
		throw new RecipeIdError(
			input,
			"version segment must be v<major> with major >= 1",
		);
	}
	const path = input.slice(0, slash).split(".");
	if (path[0] !== "recipe") {
		throw new RecipeIdError(input, "must start with the `recipe.` namespace");
	}
	const slug = path.slice(1);
	if (slug.length === 0) {
		throw new RecipeIdError(
			input,
			"must name a solution after the `recipe.` namespace",
		);
	}
	for (const segment of slug) {
		if (!SEGMENT.test(segment)) {
			throw new RecipeIdError(
				input,
				`segment ${JSON.stringify(segment)} must match ${SEGMENT.source}`,
			);
		}
	}
	// SAFETY: assertion to `input as RecipeId` is required at this boundary.
	return { id: input as RecipeId, slug, major: Number(versionMatch[1]) };
}

export function tryParseRecipeId(input: string): ParsedRecipeId | undefined {
	try {
		return parseRecipeId(input);
	} catch {
		return undefined;
	}
}

/** Local identifiers (yard, camp, placement, edge) inside a recipe. */
const LOCAL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function isLocalRecipeId(value: string): boolean {
	return (
		Object.prototype.toString.call(value) === "[object String]" &&
		LOCAL_ID.test(value)
	);
}
