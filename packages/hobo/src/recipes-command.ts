import type { CommandModule } from "@hobo/cli";

import {
	listRecipeSummaries,
	RecipePlaneError,
	requireRecipe,
	summarizeRecipe,
} from "./recipe-plane.js";

// `hobo recipes` — the read-only view of what HoBo knows how to deploy before
// anyone has authenticated with a provider. It reads the same registry the
// offer compiler and the example page read; there is no second recipe list.
//
//   hobo recipes list            every registered recipe and its claim terms
//   hobo recipes show <id>       one recipe's Yards, placements, and consents

export function createRecipesCommand(): CommandModule {
	return {
		run: async ({ args }) => {
			const subcommand = args[0] ?? "list";

			if (subcommand === "list") {
				const recipes = listRecipeSummaries();
				return {
					ok: true,
					status: "listed",
					code: "HOBO_RECIPES_LISTED",
					message: `hobo recipes: ${recipes.length} registered`,
					data: { command: "recipes", recipes },
				};
			}

			if (subcommand === "show") {
				const recipeId = args[1];
				if (recipeId === undefined) {
					return {
						ok: false,
						status: "usage",
						code: "HOBO_RECIPES_USAGE",
						message: "hobo recipes show <recipe-id>",
						remediation: [
							"Run `hobo recipes list` to see registered recipe ids.",
						],
					};
				}
				try {
					const recipe = requireRecipe(recipeId);
					return {
						ok: true,
						status: "shown",
						code: "HOBO_RECIPES_SHOWN",
						message: `hobo recipes show ${recipe.id}: ${recipe.displayName}`,
						data: {
							command: "recipes",
							summary: summarizeRecipe(recipe),
							description: recipe.description,
							delivers: recipe.delivers,
							yards: recipe.yards.map((yard) => ({
								yardId: yard.yardId,
								providerId: yard.providerId,
								resourceOnly: yard.resourceOnly,
								sponsored: yard.sponsored,
								bootstrapClass: yard.lease.bootstrapClass,
								cleanupPolicy: yard.lease.cleanupPolicy,
								renewable: yard.lease.renewable,
								claimByMsFromStart: yard.lease.claimByMsFromStart,
							})),
							placements: recipe.placements.map((placement) => ({
								placementId: placement.placementId,
								yardId: placement.yardId,
								campId: placement.campId ?? null,
								primitive: placement.primitive,
								capabilityRef: placement.capabilityRef,
								satisfiesProfileId: placement.satisfiesProfileId,
								productDefinitionId: placement.productDefinitionId,
								claimMode: placement.claim.mode,
								claimAtomicity: placement.claim.atomicity,
								claimActionCount: placement.claim.actionCount,
								creatorAuthorityAfterClaim:
									placement.claim.creatorAuthorityAfterClaim,
								postClaimActions: placement.claim.postClaimActions,
							})),
							edges: recipe.edges.map((edge) => ({
								edgeId: edge.edgeId,
								fromPlacementId: edge.fromPlacementId,
								toPlacementId: edge.toPlacementId,
								primary: edge.primary,
								fallbacks: edge.fallbacks,
							})),
							requiredConsents: recipe.bootstrap.requiredConsents,
							sponsoredCostCapMinorUnits:
								recipe.bootstrap.sponsoredCostCapMinorUnits,
						},
					};
				} catch (error) {
					if (error instanceof RecipePlaneError) {
						return {
							ok: false,
							status: "unknown-recipe",
							code: "HOBO_RECIPES_UNKNOWN",
							message: error.message,
							remediation: [
								"Run `hobo recipes list` to see registered recipe ids.",
							],
						};
					}
					throw error;
				}
			}

			return {
				ok: false,
				status: "usage",
				code: "HOBO_RECIPES_USAGE",
				message: `hobo recipes: unknown subcommand "${subcommand}"`,
				remediation: [
					"Use `hobo recipes list` or `hobo recipes show <recipe-id>`.",
				],
			};
		},
	};
}
