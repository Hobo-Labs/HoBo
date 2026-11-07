/**
 * The SolutionRecipe schema.
 *
 * A recipe is data, not code: it declares the Yards it creates, where each
 * Bindle capability is placed, which product definition it prefers for that
 * placement, how cross-Yard edges are wired, and what it promises about claim
 * and bootstrap semantics. It never mutates the Bindle and never contains an
 * effect.
 */
import type {
	BindlePrimitive,
	BindleRuntime,
	ClaimAtomicity,
	CreatorAuthorityAfterClaim,
} from "@hobo/capability-profiles";
import {
	isBindlePrimitive,
	isBindleRuntime,
	parseProfileId,
} from "@hobo/capability-profiles";
import type {
	BootstrapClass,
	GuestLeaseCleanupPolicy,
	OwnershipTransitionMode,
	PostClaimAction,
} from "@hobo/claims";

import { isLocalRecipeId, parseRecipeId, type RecipeId } from "./ids.js";

// public-contract: versions portable solution recipes.
export const SOLUTION_RECIPE_SCHEMA_VERSION = "hobo.solution-recipe/v1";

/** Where credential material lives once the deployment is running. */
export type CredentialCustody = "secret-ref" | "plaintext";

/** How the deployment is paid for before it is claimed. */
export type BootstrapFunding = "public-anonymous" | "sponsored";

export type PersistenceGrade = "persistent" | "ephemeral";

export type RealtimeGrade = "websocket" | "polling" | "none";

export type ClaimKind = "provider-native" | "sponsor-migration";

export type SourceDisclosure =
	| "public-source"
	| "private-source"
	| "not-applicable";

/**
 * The semantic axes a caller can be silently downgraded along.
 *
 * Requested and delivered semantics are compared axis by axis, so a downgrade
 * is a fact the compiler derives rather than a judgement it makes.
 */
// parallel-type-allowed: the authored semantics axes as closed unions (ClaimKind, PersistenceGrade, RealtimeGrade, …); hobo.recipes.v1.RecipeSemantics widens each of them to a string for the wire.
export type RecipeSemantics = {
	readonly claimCount: number;
	readonly claimKind: ClaimKind;
	readonly persistence: PersistenceGrade;
	readonly realtime: RealtimeGrade;
	readonly credentialCustody: CredentialCustody;
	readonly bootstrap: BootstrapFunding;
};

// parallel-type-allowed: the authored lease with BootstrapClass and GuestLeaseCleanupPolicy unions from @hobo/claims; hobo.recipes.v1.RecipeLease is its wire projection.
export type RecipeLease = {
	readonly bootstrapClass: BootstrapClass;
	readonly cleanupPolicy: GuestLeaseCleanupPolicy;
	readonly renewable: boolean;
	/**
	 * Relative to the compile instant. Recipes carry offsets, never absolute
	 * instants, because a recipe outlives any particular deployment.
	 */
	readonly claimByMsFromStart: number;
};

export type RecipeYardInput = {
	readonly yardId: string;
	readonly providerId: string;
	/** A Yard that holds managed resources and zero Camps. Legal and supported. */
	readonly resourceOnly: boolean;
	readonly sponsored: boolean;
	readonly regions?: readonly string[];
	readonly lease: RecipeLease;
};

export type RecipeYard = Omit<RecipeYardInput, "regions"> & {
	readonly regions: readonly string[];
};

export type RecipeClaimExpectationInput = {
	readonly mode: OwnershipTransitionMode;
	readonly atomicity: ClaimAtomicity;
	readonly actionCount: number;
	readonly deadlineMsFromStart?: number;
	readonly creatorAuthorityAfterClaim: CreatorAuthorityAfterClaim;
	readonly postClaimActions?: readonly PostClaimAction[];
};

export type RecipeClaimExpectation = Omit<
	RecipeClaimExpectationInput,
	"postClaimActions"
> & {
	readonly postClaimActions: readonly PostClaimAction[];
};

export type RecipePlacementInput = {
	readonly placementId: string;
	readonly yardId: string;
	/** Absent for a placement in a resource-only Yard. */
	readonly campId?: string;
	readonly primitive: BindlePrimitive;
	/** The Bindle capability slot this placement covers. */
	readonly capabilityRef: string;
	/** The capability profile this placement promises to satisfy. */
	readonly satisfiesProfileId: string;
	readonly productDefinitionId: string;
	readonly runtimeModel?: BindleRuntime;
	readonly claim: RecipeClaimExpectationInput;
};

export type RecipePlacement = Omit<RecipePlacementInput, "claim"> & {
	readonly claim: RecipeClaimExpectation;
};

// parallel-type-allowed: the authored connectivity choice; hobo.recipes.v1.RecipeConnectivityChoice is its wire projection and this form is what the parser deduplicates edges by.
export type RecipeConnectivityChoice = {
	readonly connectivityImplementationId: string;
	readonly bindingProfileRef: string;
};

export type RecipeConnectivityEdgeInput = {
	readonly edgeId: string;
	/** The consuming placement. */
	readonly fromPlacementId: string;
	/** The producing placement. */
	readonly toPlacementId: string;
	readonly primary: RecipeConnectivityChoice;
	/** Ordered preference list. Order is authored, so it is part of identity. */
	readonly fallbacks?: readonly RecipeConnectivityChoice[];
};

export type RecipeConnectivityEdge = Omit<
	RecipeConnectivityEdgeInput,
	"fallbacks"
> & {
	readonly fallbacks: readonly RecipeConnectivityChoice[];
};

export type RecipeBootstrapExpectationInput = {
	readonly sponsoredCostCapMinorUnits: number;
	readonly sourceDisclosure: SourceDisclosure;
	readonly requiredConsents?: readonly string[];
	readonly offerTtlMs: number;
};

export type RecipeBootstrapExpectation = Omit<
	RecipeBootstrapExpectationInput,
	"requiredConsents"
> & {
	readonly requiredConsents: readonly string[];
};

export type SolutionRecipeInput = {
	readonly schemaVersion: typeof SOLUTION_RECIPE_SCHEMA_VERSION;
	readonly id: string;
	readonly displayName: string;
	readonly description: string;
	readonly yards: readonly RecipeYardInput[];
	readonly placements: readonly RecipePlacementInput[];
	readonly edges?: readonly RecipeConnectivityEdgeInput[];
	readonly delivers: RecipeSemantics;
	readonly bootstrap: RecipeBootstrapExpectationInput;
};

const solutionRecipeBrand: unique symbol = Symbol("SolutionRecipe");

/** Parsed recipe. Construct only through {@link parseSolutionRecipe}. */
// parallel-type-allowed: the branded parse-don't-validate refinement of hobo.recipes.v1.SolutionRecipe — constructed only by parseSolutionRecipe, with a branded RecipeId and canonically ordered yards, placements, and edges.
export type SolutionRecipe = {
	readonly schemaVersion: typeof SOLUTION_RECIPE_SCHEMA_VERSION;
	readonly id: RecipeId;
	readonly displayName: string;
	readonly description: string;
	readonly yards: readonly RecipeYard[];
	readonly placements: readonly RecipePlacement[];
	readonly edges: readonly RecipeConnectivityEdge[];
	readonly delivers: RecipeSemantics;
	readonly bootstrap: RecipeBootstrapExpectation;
	readonly [solutionRecipeBrand]: "SolutionRecipe";
};

export class SolutionRecipeError extends Error {
	readonly code = "INVALID_SOLUTION_RECIPE" as const;
	readonly recipeId: string;

	constructor(recipeId: string, detail: string) {
		super(`solution recipe ${recipeId}: ${detail}`);
		this.name = "SolutionRecipeError";
		this.recipeId = recipeId;
	}
}

const CLAIM_ATOMICITIES: readonly ClaimAtomicity[] = [
	"single-resource",
	"provider-bundled",
	"best-effort-saga",
];

const CLEANUP_POLICIES: readonly GuestLeaseCleanupPolicy[] = [
	"delete",
	"retain-until-provider-expiry",
	"transfer",
	"migrate",
];

const PROVIDER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function sortedUnique(values: readonly string[]): readonly string[] {
	return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function requirePositiveInteger(
	value: number,
	recipeId: string,
	field: string,
): number {
	if (!Number.isInteger(value) || value <= 0) {
		throw new SolutionRecipeError(
			recipeId,
			`${field} must be a positive integer`,
		);
	}
	return value;
}

function parseLease(
	lease: RecipeLease,
	recipeId: string,
	yardId: string,
): RecipeLease {
	if (!CLEANUP_POLICIES.includes(lease.cleanupPolicy)) {
		throw new SolutionRecipeError(
			recipeId,
			`yard ${yardId} declares unknown cleanup policy ${JSON.stringify(lease.cleanupPolicy)}`,
		);
	}
	requirePositiveInteger(
		lease.claimByMsFromStart,
		recipeId,
		`yard ${yardId} lease claimByMsFromStart`,
	);
	return {
		bootstrapClass: lease.bootstrapClass,
		cleanupPolicy: lease.cleanupPolicy,
		renewable: lease.renewable,
		claimByMsFromStart: lease.claimByMsFromStart,
	};
}

function parseClaim(
	claim: RecipeClaimExpectationInput,
	recipeId: string,
	placementId: string,
): RecipeClaimExpectation {
	if (!CLAIM_ATOMICITIES.includes(claim.atomicity)) {
		throw new SolutionRecipeError(
			recipeId,
			`placement ${placementId} declares unknown claim atomicity ${JSON.stringify(claim.atomicity)}`,
		);
	}
	if (!Number.isInteger(claim.actionCount) || claim.actionCount < 0) {
		throw new SolutionRecipeError(
			recipeId,
			`placement ${placementId} claim actionCount must be a non-negative integer`,
		);
	}
	// A transition that transfers nothing cannot cost a human anything.
	if (claim.mode === "none" && claim.actionCount > 0) {
		throw new SolutionRecipeError(
			recipeId,
			`placement ${placementId} declares ${claim.actionCount} claim actions for an ownership transition of "none"`,
		);
	}
	if (claim.deadlineMsFromStart !== undefined) {
		requirePositiveInteger(
			claim.deadlineMsFromStart,
			recipeId,
			`placement ${placementId} claim deadlineMsFromStart`,
		);
	}
	return {
		mode: claim.mode,
		atomicity: claim.atomicity,
		actionCount: claim.actionCount,
		...(claim.deadlineMsFromStart !== undefined
			? { deadlineMsFromStart: claim.deadlineMsFromStart }
			: undefined),
		creatorAuthorityAfterClaim: claim.creatorAuthorityAfterClaim,
		// SAFETY: assertion to `(claim.postClaimActions ?? [])].sort((a, b) => a.localeCompare(b), ) as readonly PostClaimAction[], }` is required at this boundary.
		postClaimActions: [...(claim.postClaimActions ?? [])].sort((a, b) =>
			a.localeCompare(b),
		) as readonly PostClaimAction[],
	};
}

/**
 * Parse-don't-validate boundary for a recipe.
 *
 * Everything is canonically ordered so two recipes that differ only in
 * authoring order compile to byte-identical output.
 */
export function parseSolutionRecipe(
	input: SolutionRecipeInput,
): SolutionRecipe {
	const rawId = String(input.id);
	if (input.schemaVersion !== SOLUTION_RECIPE_SCHEMA_VERSION) {
		throw new SolutionRecipeError(
			rawId,
			`unsupported schemaVersion ${String(input.schemaVersion)}`,
		);
	}
	const parsedId = parseRecipeId(rawId);
	const recipeId = parsedId.id;

	if (input.yards.length === 0) {
		throw new SolutionRecipeError(recipeId, "must declare at least one yard");
	}
	if (input.placements.length === 0) {
		throw new SolutionRecipeError(
			recipeId,
			"must declare at least one placement",
		);
	}

	const yards = new Map<string, RecipeYard>();
	for (const yard of input.yards) {
		if (!isLocalRecipeId(yard.yardId)) {
			throw new SolutionRecipeError(
				recipeId,
				`yard id ${JSON.stringify(yard.yardId)} must be a lowercase dns-style label`,
			);
		}
		if (yards.has(yard.yardId)) {
			throw new SolutionRecipeError(
				recipeId,
				`declares duplicate yard ${yard.yardId}`,
			);
		}
		if (!PROVIDER_ID.test(yard.providerId)) {
			throw new SolutionRecipeError(
				recipeId,
				`yard ${yard.yardId} providerId ${JSON.stringify(yard.providerId)} must be a lowercase dns-style label`,
			);
		}
		yards.set(yard.yardId, {
			yardId: yard.yardId,
			providerId: yard.providerId,
			resourceOnly: yard.resourceOnly,
			sponsored: yard.sponsored,
			regions: sortedUnique(yard.regions ?? []),
			lease: parseLease(yard.lease, recipeId, yard.yardId),
		});
	}

	const placements = new Map<string, RecipePlacement>();
	const capabilityRefs = new Set<string>();
	for (const placement of input.placements) {
		if (!isLocalRecipeId(placement.placementId)) {
			throw new SolutionRecipeError(
				recipeId,
				`placement id ${JSON.stringify(placement.placementId)} must be a lowercase dns-style label`,
			);
		}
		if (placements.has(placement.placementId)) {
			throw new SolutionRecipeError(
				recipeId,
				`declares duplicate placement ${placement.placementId}`,
			);
		}
		const yard = yards.get(placement.yardId);
		if (yard === undefined) {
			throw new SolutionRecipeError(
				recipeId,
				`placement ${placement.placementId} references unknown yard ${placement.yardId}`,
			);
		}
		// A resource-only Yard exists precisely so a managed resource does not
		// need a Camp. Fabricating an empty Camp to host it would be a lie in
		// the topology and a second ownership boundary in the offer.
		if (yard.resourceOnly && placement.campId !== undefined) {
			throw new SolutionRecipeError(
				recipeId,
				`placement ${placement.placementId} names a camp inside resource-only yard ${yard.yardId}`,
			);
		}
		if (!yard.resourceOnly && placement.campId === undefined) {
			throw new SolutionRecipeError(
				recipeId,
				`placement ${placement.placementId} needs a camp: yard ${yard.yardId} is not resource-only`,
			);
		}
		if (placement.campId !== undefined && !isLocalRecipeId(placement.campId)) {
			throw new SolutionRecipeError(
				recipeId,
				`camp id ${JSON.stringify(placement.campId)} must be a lowercase dns-style label`,
			);
		}
		if (!isBindlePrimitive(placement.primitive)) {
			throw new SolutionRecipeError(
				recipeId,
				`placement ${placement.placementId} declares unknown primitive ${JSON.stringify(placement.primitive)}`,
			);
		}
		if (
			placement.runtimeModel !== undefined &&
			!isBindleRuntime(placement.runtimeModel)
		) {
			throw new SolutionRecipeError(
				recipeId,
				`placement ${placement.placementId} declares unknown runtime ${JSON.stringify(placement.runtimeModel)}`,
			);
		}
		const profile = parseProfileId(placement.satisfiesProfileId);
		if (profile.primitive !== placement.primitive) {
			throw new SolutionRecipeError(
				recipeId,
				`placement ${placement.placementId} promises ${profile.id} which is not a ${placement.primitive} profile`,
			);
		}
		if (placement.capabilityRef.trim().length === 0) {
			throw new SolutionRecipeError(
				recipeId,
				`placement ${placement.placementId} must name the bindle capability it covers`,
			);
		}
		// Two placements covering one capability is a double-provision, not a
		// redundancy feature.
		if (capabilityRefs.has(placement.capabilityRef)) {
			throw new SolutionRecipeError(
				recipeId,
				`capability ${placement.capabilityRef} is covered by more than one placement`,
			);
		}
		capabilityRefs.add(placement.capabilityRef);
		if (placement.productDefinitionId.trim().length === 0) {
			throw new SolutionRecipeError(
				recipeId,
				`placement ${placement.placementId} must name a product definition`,
			);
		}

		placements.set(placement.placementId, {
			placementId: placement.placementId,
			yardId: placement.yardId,
			...(placement.campId !== undefined
				? { campId: placement.campId }
				: undefined),
			primitive: placement.primitive,
			capabilityRef: placement.capabilityRef,
			satisfiesProfileId: profile.id,
			productDefinitionId: placement.productDefinitionId,
			...(placement.runtimeModel !== undefined
				? { runtimeModel: placement.runtimeModel }
				: undefined),
			claim: parseClaim(placement.claim, recipeId, placement.placementId),
		});
	}

	const edges = new Map<string, RecipeConnectivityEdge>();
	for (const edge of input.edges ?? []) {
		if (!isLocalRecipeId(edge.edgeId)) {
			throw new SolutionRecipeError(
				recipeId,
				`edge id ${JSON.stringify(edge.edgeId)} must be a lowercase dns-style label`,
			);
		}
		if (edges.has(edge.edgeId)) {
			throw new SolutionRecipeError(
				recipeId,
				`declares duplicate edge ${edge.edgeId}`,
			);
		}
		for (const end of [edge.fromPlacementId, edge.toPlacementId]) {
			if (!placements.has(end)) {
				throw new SolutionRecipeError(
					recipeId,
					`edge ${edge.edgeId} references unknown placement ${end}`,
				);
			}
		}
		if (edge.fromPlacementId === edge.toPlacementId) {
			throw new SolutionRecipeError(
				recipeId,
				`edge ${edge.edgeId} connects placement ${edge.fromPlacementId} to itself`,
			);
		}
		const choices = [edge.primary, ...(edge.fallbacks ?? [])];
		const seenChoices = new Set<string>();
		for (const choice of choices) {
			const key = `${choice.connectivityImplementationId}\u0000${choice.bindingProfileRef}`;
			if (seenChoices.has(key)) {
				throw new SolutionRecipeError(
					recipeId,
					`edge ${edge.edgeId} lists ${choice.connectivityImplementationId} more than once`,
				);
			}
			seenChoices.add(key);
		}
		edges.set(edge.edgeId, {
			edgeId: edge.edgeId,
			fromPlacementId: edge.fromPlacementId,
			toPlacementId: edge.toPlacementId,
			primary: edge.primary,
			fallbacks: [...(edge.fallbacks ?? [])],
		});
	}

	const declaredClaims = [...placements.values()].filter(
		(placement) => placement.claim.mode !== "none",
	).length;
	if (input.delivers.claimCount !== declaredClaims) {
		throw new SolutionRecipeError(
			recipeId,
			`declares ${input.delivers.claimCount} delivered claims but ${declaredClaims} placements carry an ownership transition`,
		);
	}
	const sponsoredYard = [...yards.values()].some((yard) => yard.sponsored);
	if (sponsoredYard && input.delivers.bootstrap !== "sponsored") {
		throw new SolutionRecipeError(
			recipeId,
			"declares a sponsored yard but promises a public-anonymous bootstrap",
		);
	}
	if (
		input.delivers.claimKind === "sponsor-migration" &&
		input.delivers.bootstrap !== "sponsored"
	) {
		throw new SolutionRecipeError(
			recipeId,
			"a sponsor-migration claim is only coherent with a sponsored bootstrap",
		);
	}
	if (input.bootstrap.sponsoredCostCapMinorUnits < 0) {
		throw new SolutionRecipeError(
			recipeId,
			"sponsoredCostCapMinorUnits must not be negative",
		);
	}
	if (!sponsoredYard && input.bootstrap.sponsoredCostCapMinorUnits > 0) {
		throw new SolutionRecipeError(
			recipeId,
			"declares a sponsor cost cap without a sponsored yard",
		);
	}
	requirePositiveInteger(
		input.bootstrap.offerTtlMs,
		recipeId,
		"bootstrap offerTtlMs",
	);

	return {
		schemaVersion: SOLUTION_RECIPE_SCHEMA_VERSION,
		id: recipeId,
		displayName: input.displayName,
		description: input.description,
		yards: [...yards.values()].sort((a, b) => a.yardId.localeCompare(b.yardId)),
		placements: [...placements.values()].sort((a, b) =>
			a.placementId.localeCompare(b.placementId),
		),
		edges: [...edges.values()].sort((a, b) => a.edgeId.localeCompare(b.edgeId)),
		delivers: {
			claimCount: input.delivers.claimCount,
			claimKind: input.delivers.claimKind,
			persistence: input.delivers.persistence,
			realtime: input.delivers.realtime,
			credentialCustody: input.delivers.credentialCustody,
			bootstrap: input.delivers.bootstrap,
		},
		bootstrap: {
			sponsoredCostCapMinorUnits: input.bootstrap.sponsoredCostCapMinorUnits,
			sourceDisclosure: input.bootstrap.sourceDisclosure,
			requiredConsents: sortedUnique(input.bootstrap.requiredConsents ?? []),
			offerTtlMs: input.bootstrap.offerTtlMs,
		},
		[solutionRecipeBrand]: "SolutionRecipe",
	};
}
