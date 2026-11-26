/**
 * No silent widening. Every case is a line in `widening.cases.jsonl`.
 *
 * The rule has two halves and the old suite asserted both inside one test:
 * without an explicit policy allowance the downgrade is a refusal, and with one
 * it is still disclosed in the offer. Splitting them means a refusal that stops
 * refusing and a disclosure that goes quiet are two different red lines rather
 * than one.
 */
import { readFileSync } from "node:fs";
import type { CapabilityRequirementInput } from "@hobo/capability-profiles";
import { describeConcern } from "@hobo/contract-harness";
import {
	buildDeploymentOffer,
	compileRecipe,
	type DeploymentRequest,
	findStandardRecipe,
	parseDeploymentRequest,
	parseSolutionRecipe,
	type RecipePolicyInput,
	type RecipeSemantics,
	type SolutionRecipe,
	type SolutionRecipeInput,
	WIDENING_KINDS,
} from "../src/index.js";
import {
	CATALOG,
	CATALOG_DIGEST,
	capabilityFor,
	catalogDigestOf,
	compileInputFor,
	NOW,
	PROFILE_REGISTRY_DIGEST,
	policyWith,
	requestForRecipe,
	SIGNER,
} from "./fixtures.js";

const CASES = `${import.meta.dirname}/widening.cases.jsonl`;

function recipeById(id: string): SolutionRecipe {
	const recipe = findStandardRecipe(id);
	if (recipe === undefined) throw new Error(`missing fixture recipe ${id}`);
	return recipe;
}

const RECIPES = {
	inbox: recipeById("recipe.cloudflare.claimable-webhook-inbox/v1"),
	sqlApi: recipeById("recipe.cloudflare-neon.portable-sql-api/v1"),
	leaderboard: recipeById("recipe.cloudflare-upstash.live-leaderboard/v1"),
	netlifyReport: recipeById("recipe.netlify.claimable-generated-report/v1"),
	issueTracker: recipeById("recipe.vercel-prisma.claimable-issue-tracker/v1"),
	convexCloud: recipeById("recipe.convex-cloud.sponsored-transfer/v1"),
	neonSandbox: recipeById("recipe.neon.claimable-sql-sandbox/v1"),
} as const;

/** Rewrite the neon candidate's realization, for the realization lane. */
const catalogWith = (realization: "pack" | "bridge") =>
	CATALOG.map((candidate) =>
		candidate.definitionId === "neon.claimable-postgres/v1"
			? {
					...candidate,
					implementsProfiles: candidate.implementsProfiles.map((entry) => ({
						...entry,
						realization,
					})),
				}
			: candidate,
	);

interface CapabilitySpec {
	readonly ref: string;
	readonly profileId: string;
	readonly extra?: Partial<CapabilityRequirementInput>;
}

interface Ask {
	readonly recipe: keyof typeof RECIPES;
	/** Rewrite placements onto a weaker profile before compiling. */
	readonly weaken?: {
		readonly id: string;
		readonly to: string;
		readonly placementId?: string;
	};
	/**
	 * Rewrite what the recipe *delivers*, keeping the request asking for the
	 * original. That is the credential lane: the recipe weakens, not the caller.
	 */
	readonly deliver?: {
		readonly id: string;
		readonly delivers: Partial<RecipeSemantics>;
	};
	/** Merged over the recipe's own `delivers`. */
	readonly semantics?: Partial<RecipeSemantics>;
	/** A hand-built request, when the recipe's own is not the subject. */
	readonly request?: {
		readonly deploymentRef: string;
		readonly capabilities: readonly CapabilitySpec[];
		readonly dependencies?: DeploymentRequest["dependencies"];
	};
	readonly catalogRealization?: "pack" | "bridge";
	readonly policy?: Partial<RecipePolicyInput>;
}

function recipeInput(recipe: SolutionRecipe): SolutionRecipeInput {
	return {
		schemaVersion: recipe.schemaVersion,
		id: recipe.id,
		displayName: recipe.displayName,
		description: recipe.description,
		yards: recipe.yards,
		placements: recipe.placements,
		edges: recipe.edges,
		delivers: recipe.delivers,
		bootstrap: recipe.bootstrap,
	};
}

function compilationFor(ask: Ask) {
	const base = RECIPES[ask.recipe];
	const delivered = ask.deliver
		? parseSolutionRecipe({
				...recipeInput(base),
				id: ask.deliver.id,
				delivers: { ...base.delivers, ...ask.deliver.delivers },
			})
		: base;
	const recipe = ask.weaken
		? parseSolutionRecipe({
				...recipeInput(delivered),
				id: ask.weaken.id,
				placements: delivered.placements.map((placement) =>
					ask.weaken?.placementId === undefined ||
					placement.placementId === ask.weaken.placementId
						? { ...placement, satisfiesProfileId: ask.weaken.to }
						: placement,
				),
			})
		: delivered;

	const fromRecipe = requestForRecipe(recipe);
	const request = ask.request
		? parseDeploymentRequest({
				deploymentRef: ask.request.deploymentRef,
				capabilities: ask.request.capabilities.map((capability) =>
					capabilityFor(capability.ref, capability.profileId, capability.extra),
				),
				...(ask.request.dependencies === undefined
					? undefined
					: { dependencies: ask.request.dependencies }),
				requestedSemantics: recipe.delivers,
			})
		: ask.deliver
			? parseDeploymentRequest({
					deploymentRef: fromRecipe.deploymentRef,
					capabilities: fromRecipe.capabilities,
					dependencies: fromRecipe.dependencies,
					requestedSemantics: base.delivers,
				})
			: ask.semantics
				? parseDeploymentRequest({
						deploymentRef: fromRecipe.deploymentRef,
						capabilities: fromRecipe.capabilities,
						dependencies: fromRecipe.dependencies,
						requestedSemantics: { ...recipe.delivers, ...ask.semantics },
					})
				: fromRecipe;

	const catalog = ask.catalogRealization
		? catalogWith(ask.catalogRealization)
		: undefined;

	return {
		recipe,
		request,
		compilation: compileRecipe(
			compileInputFor(recipe, {
				request,
				...(catalog === undefined
					? undefined
					: { catalog, catalogDigest: catalogDigestOf(catalog) }),
				...(ask.policy === undefined
					? undefined
					: { policy: policyWith(ask.policy) }),
			}),
		),
	};
}

describeConcern("widening", {
	cases: CASES,
	subject: () => ({
		/** One compile, reduced to the refusal codes and the disclosed widenings. */
		compile: (ask: Ask) => {
			const { compilation } = compilationFor(ask);
			return {
				ok: compilation.ok,
				rejectionCodes: compilation.rejections
					.map((rejection) => rejection.code)
					.sort(),
				wideningKinds: compilation.ok
					? compilation.widenings.map((notice) => notice.kind)
					: [],
				wideningPlacements: compilation.ok
					? compilation.widenings.map((notice) => notice.placementId)
					: [],
			};
		},
		/** A permitted widening is only safe if the offer still says so. */
		offerNotices: (ask: Ask) => {
			const { recipe, request, compilation } = compilationFor(ask);
			if (!compilation.ok)
				throw new Error("expected the permitted widenings to compile");
			return buildDeploymentOffer({
				compilation,
				recipe,
				request,
				catalogDigest: CATALOG_DIGEST,
				profileRegistryDigest: PROFILE_REGISTRY_DIGEST,
				issuedAtMs: NOW,
				signer: SIGNER,
			}).degradationNotices.map((notice) => notice.kind);
		},
		/** The declared kinds, so a removal is caught. */
		declaredKinds: () => [...WIDENING_KINDS].sort(),
		/**
		 * Kinds with no case, which is the guard this module actually needs.
		 *
		 * The test this replaces carried the comment "a new kind added without a
		 * case here is the silent widening this module exists to prevent" while
		 * asserting only that the constant list had not changed — it never
		 * checked that a kind was exercised. This reads the case file.
		 */
		kindsWithoutCases: () => {
			const text = readFileSync(CASES, "utf8");
			return [...WIDENING_KINDS]
				.filter((kind) => !text.includes(`"${kind}"`))
				.sort();
		},
	}),
});
