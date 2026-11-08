/**
 * Platform recipe catalog (OpenRewrite-inspired composition).
 * identity.continuous is hands-off — zero Bindle config required.
 */
import {
	defineTrail,
	type TrailDefinition,
	type TrailStep,
} from "./definition.js";

// public-contract: platform recipe ids.
export const PLATFORM_RECIPES = Object.freeze({
	IdentityContinuous: "identity.continuous",
	JunctionRebind: "junction.rebind",
	SecretlessReresolve: "secretless.reresolve",
	ValidationOracle: "validation.oracle",
	CutoverGate: "cutover.gate",
	SchemaApply: "schema.apply",
} as const);

export type PlatformRecipeId =
	(typeof PLATFORM_RECIPES)[keyof typeof PLATFORM_RECIPES];

export type PlatformRecipe = Readonly<{
	id: PlatformRecipeId;
	description: string;
	/** Expands into concrete Trail steps. */
	expand: () => readonly TrailStep[];
	/** Pure continuous identity requires no app authoring. */
	bindleConfigRequired: boolean;
	handsOffContinuous: boolean;
}>;

const catalog = {
	[PLATFORM_RECIPES.IdentityContinuous]: {
		id: PLATFORM_RECIPES.IdentityContinuous,
		description:
			"Continuous dual-path identity migration (Matching/policy; zero Bindle config)",
		bindleConfigRequired: false,
		handsOffContinuous: true,
		expand: () =>
			Object.freeze([
				Object.freeze({
					id: "identity-continuous-dual",
					kind: "identity-continuous" as const,
					description: "Platform dual-path PrincipalRef continuity",
					progressive: true,
					identity: {
						continuous: true as const,
						bindleConfigRequired: false as const,
					},
				}),
			]),
	},
	[PLATFORM_RECIPES.JunctionRebind]: {
		id: PLATFORM_RECIPES.JunctionRebind,
		description: "Rebind junction / overlay for cross-cloud dual reachability",
		bindleConfigRequired: false,
		handsOffContinuous: false,
		expand: () =>
			Object.freeze([
				Object.freeze({
					id: "junction-rebind",
					kind: "junction-rebind" as const,
					junction: Object.freeze({ required: true }),
				}),
			]),
	},
	[PLATFORM_RECIPES.SecretlessReresolve]: {
		id: PLATFORM_RECIPES.SecretlessReresolve,
		description: "Re-resolve secretless config after target change",
		bindleConfigRequired: false,
		handsOffContinuous: false,
		expand: () =>
			Object.freeze([
				Object.freeze({
					id: "secretless-reresolve",
					kind: "secretless-reresolve" as const,
				}),
			]),
	},
	[PLATFORM_RECIPES.ValidationOracle]: {
		id: PLATFORM_RECIPES.ValidationOracle,
		description: "Golden dual-consistency / zero-loss validation",
		bindleConfigRequired: false,
		handsOffContinuous: false,
		// dependsOn for app dual/schema steps is wired by wireTrailPhaseDependencies
		// (platform recipes cannot know app step ids at expand time).
		expand: () =>
			Object.freeze([
				Object.freeze({
					id: "validation-oracle",
					kind: "validation" as const,
					oracleId: "golden.dual-consistency",
				}),
			]),
	},
	[PLATFORM_RECIPES.CutoverGate]: {
		id: PLATFORM_RECIPES.CutoverGate,
		description: "Cutover gate after dual window is healthy",
		bindleConfigRequired: false,
		handsOffContinuous: false,
		// Depends on validation-oracle; wireTrailPhaseDependencies also ties
		// validation to dual/schema/data so cutover cannot beat dual by id sort.
		expand: () =>
			Object.freeze([
				Object.freeze({
					id: "cutover-gate",
					kind: "cutover" as const,
					dependsOn: Object.freeze(["validation-oracle"]),
				}),
			]),
	},
	[PLATFORM_RECIPES.SchemaApply]: {
		id: PLATFORM_RECIPES.SchemaApply,
		description: "Apply versioned schema (expand/contract when dual)",
		bindleConfigRequired: false,
		handsOffContinuous: false,
		expand: () =>
			Object.freeze([
				Object.freeze({
					id: "schema-apply",
					kind: "schema" as const,
					schema: Object.freeze({
						mode: "expand-contract" as const,
						version: "platform",
					}),
					progressive: true,
				}),
			]),
	},
};

export function getPlatformRecipe(id: string): PlatformRecipe | undefined {
	return Object.entries(catalog).find(([key]) => key === id)?.[1];
}

export function listPlatformRecipes(): readonly PlatformRecipe[] {
	return Object.freeze(Object.values(catalog));
}

/**
 * Expand recipeList into concrete steps (hierarchical composition).
 * identity.continuous expands without any Bindle fields.
 */
export function expandRecipes(
	recipeIds: readonly string[],
): readonly TrailStep[] {
	const steps: TrailStep[] = [];
	for (const id of recipeIds) {
		const recipe = getPlatformRecipe(id);
		if (!recipe) {
			throw Object.assign(new Error(`unknown platform recipe: ${id}`), {
				code: "trail-recipe-missing",
			});
		}
		steps.push(...recipe.expand());
	}
	return Object.freeze(steps);
}

/**
 * Built-in hands-off Trail for pure continuous identity (zero app authoring).
 * Matching/policy activate this; Bindle config is never required.
 */
export function identityContinuousTrail(version = "1.0.0"): TrailDefinition {
	return defineTrail({
		id: "platform.identity.continuous",
		version,
		description:
			"Platform continuous identity dual-path (hands-off; zero Bindle config)",
		targets: ["*"],
		recipeList: [PLATFORM_RECIPES.IdentityContinuous],
	});
}

/**
 * Compose app Trail with platform recipes (recipeList + steps).
 */
export function composeTrailWithRecipes(
	trail: TrailDefinition,
): TrailDefinition {
	const expanded = expandRecipes(trail.recipeList ?? []);
	if (expanded.length === 0) return trail;
	// Prefix recipe steps that aren't already present.
	const existing = new Set(trail.steps.map((s) => s.id));
	const merged = [
		...expanded.filter((s) => !existing.has(s.id)),
		...trail.steps,
	];
	return defineTrail({
		id: trail.id,
		version: trail.version,
		description: trail.description,
		targets: trail.targets,
		...(trail.dependsOnTrails !== undefined
			? { dependsOnTrails: trail.dependsOnTrails }
			: undefined),
		steps: merged,
		...(trail.recipeList !== undefined
			? { recipeList: trail.recipeList }
			: undefined),
	});
}
