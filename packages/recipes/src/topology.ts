/**
 * The resolved topology a recipe compiles to.
 *
 * Junction ⊃ Yard ⊃ Camp ⊃ placement is the existing hierarchy; nothing here
 * adds a primitive to it. A resource-only Yard carries resources and no Camps,
 * which is a legal shape and not a degenerate one.
 */
import type {
	BindlePrimitive,
	RealizationKind,
} from "@hobo/capability-profiles";
import type {
	ClaimAtomicity,
	CreatorAuthorityAfterClaim,
	Instant,
} from "@hobo/claims";
import type { CanonicalValue } from "@hobo/trust";

import type { RecipeId } from "./ids.js";

// public-contract: versions resolved deployment topologies.
export const RESOLVED_TOPOLOGY_SCHEMA_VERSION = "hobo.resolved-topology/v1";

// parallel-type-allowed: the compiled resource with BindlePrimitive and RealizationKind unions; hobo.recipes.v1.ResolvedResource is the persisted projection the topology digest is taken over.
export type ResolvedResource = {
	readonly resourceRef: string;
	readonly placementId: string;
	readonly capabilityRef: string;
	readonly primitive: BindlePrimitive;
	readonly satisfiesProfileId: string;
	readonly productDefinitionId: string;
	readonly realization: RealizationKind;
	readonly runtimeModel?: string;
	readonly producesBindingProfiles: readonly string[];
};

// parallel-type-allowed: the compiled Camp; hobo.recipes.v1.ResolvedCamp is its persisted projection, and this form is produced only by compileRecipe.
export type ResolvedCamp = {
	readonly campId: string;
	readonly campRef: string;
	readonly resources: readonly ResolvedResource[];
};

// parallel-type-allowed: the compiled Yard; hobo.recipes.v1.ResolvedYard is its persisted projection, and the resource-only/Camp split is enforced by the parser rather than by the wire type.
export type ResolvedYard = {
	readonly yardId: string;
	readonly yardRef: string;
	readonly providerId: string;
	readonly resourceOnly: boolean;
	readonly sponsored: boolean;
	readonly regions: readonly string[];
	readonly camps: readonly ResolvedCamp[];
	/** Resources held directly by a resource-only Yard. */
	readonly resources: readonly ResolvedResource[];
};

// parallel-type-allowed: the compiled binding; hobo.recipes.v1.ResolvedBinding is its persisted projection, produced only by the compiler's edge resolution.
export type ResolvedBinding = {
	readonly edgeId: string;
	readonly fromResourceRef: string;
	readonly toResourceRef: string;
	readonly bindingProfileRef: string;
	readonly connectivityImplementationId: string;
	readonly crossYard: boolean;
	/** True when the primary connectivity choice was not resolvable. */
	readonly usedFallback: boolean;
};

// parallel-type-allowed: the compiler's output with a branded RecipeId; hobo.recipes.v1.ResolvedTopology is the persisted projection behind topologyDigest and the golden fixtures.
export type ResolvedTopology = {
	readonly schemaVersion: typeof RESOLVED_TOPOLOGY_SCHEMA_VERSION;
	readonly recipeId: RecipeId;
	readonly junctionRef: string;
	readonly yards: readonly ResolvedYard[];
	readonly bindings: readonly ResolvedBinding[];
};

export type DerivedClaimItem = {
	readonly claimId: string;
	readonly subjectRef: string;
	readonly subjectKind: "resource";
	readonly providerId: string;
	readonly mode: string;
	readonly actionCount: number;
	readonly deadlineMs?: Instant;
	readonly creatorAuthorityAfterClaim: CreatorAuthorityAfterClaim;
	readonly postClaimActions: readonly string[];
};

export type DerivedClaimFacts = {
	readonly actionCount: number;
	readonly providerCount: number;
	readonly atomicity: ClaimAtomicity;
	readonly earliestDeadlineMs?: Instant;
	readonly items: readonly DerivedClaimItem[];
};

export type DerivedGuestLease = {
	readonly leaseId: string;
	readonly yardId: string;
	readonly subjectRef: string;
	readonly bootstrapClass: string;
	readonly cleanupPolicy: string;
	readonly renewable: boolean;
	readonly claimByMs: Instant;
};

export type PortabilitySummary = {
	readonly providerCount: number;
	readonly exportSupportedPlacements: readonly string[];
	readonly exportMissingPlacements: readonly string[];
	readonly migrationProfiles: readonly string[];
};

function resourceBody(resource: ResolvedResource): CanonicalValue {
	return {
		resourceRef: resource.resourceRef,
		placementId: resource.placementId,
		capabilityRef: resource.capabilityRef,
		primitive: resource.primitive,
		satisfiesProfileId: resource.satisfiesProfileId,
		productDefinitionId: resource.productDefinitionId,
		realization: resource.realization,
		runtimeModel: resource.runtimeModel,
		producesBindingProfiles: [...resource.producesBindingProfiles],
	};
}

/**
 * The exact bytes the topology digest is taken over.
 *
 * Written out by hand rather than reflected off the value so that adding a
 * field to the topology is a deliberate digest change, never an accidental one.
 */
export function topologyDigestBody(topology: ResolvedTopology): CanonicalValue {
	return {
		schemaVersion: topology.schemaVersion,
		recipeId: topology.recipeId,
		junctionRef: topology.junctionRef,
		yards: topology.yards.map((yard) => ({
			yardId: yard.yardId,
			yardRef: yard.yardRef,
			providerId: yard.providerId,
			resourceOnly: yard.resourceOnly,
			sponsored: yard.sponsored,
			regions: [...yard.regions],
			camps: yard.camps.map((camp) => ({
				campId: camp.campId,
				campRef: camp.campRef,
				resources: camp.resources.map(resourceBody),
			})),
			resources: yard.resources.map(resourceBody),
		})),
		bindings: topology.bindings.map((binding) => ({
			edgeId: binding.edgeId,
			fromResourceRef: binding.fromResourceRef,
			toResourceRef: binding.toResourceRef,
			bindingProfileRef: binding.bindingProfileRef,
			connectivityImplementationId: binding.connectivityImplementationId,
			crossYard: binding.crossYard,
			usedFallback: binding.usedFallback,
		})),
	};
}

export function claimFactsBody(claims: DerivedClaimFacts): CanonicalValue {
	return {
		actionCount: claims.actionCount,
		providerCount: claims.providerCount,
		atomicity: claims.atomicity,
		earliestDeadlineMs: claims.earliestDeadlineMs,
		items: claims.items.map((item) => ({
			claimId: item.claimId,
			subjectRef: item.subjectRef,
			subjectKind: item.subjectKind,
			providerId: item.providerId,
			mode: item.mode,
			actionCount: item.actionCount,
			deadlineMs: item.deadlineMs,
			creatorAuthorityAfterClaim: item.creatorAuthorityAfterClaim,
			postClaimActions: [...item.postClaimActions],
		})),
	};
}

export function guestLeasesBody(
	leases: readonly DerivedGuestLease[],
): CanonicalValue {
	return leases.map((lease) => ({
		leaseId: lease.leaseId,
		yardId: lease.yardId,
		subjectRef: lease.subjectRef,
		bootstrapClass: lease.bootstrapClass,
		cleanupPolicy: lease.cleanupPolicy,
		renewable: lease.renewable,
		claimByMs: lease.claimByMs,
	}));
}

export function portabilityBody(
	portability: PortabilitySummary,
): CanonicalValue {
	return {
		providerCount: portability.providerCount,
		exportSupportedPlacements: [...portability.exportSupportedPlacements],
		exportMissingPlacements: [...portability.exportMissingPlacements],
		migrationProfiles: [...portability.migrationProfiles],
	};
}
