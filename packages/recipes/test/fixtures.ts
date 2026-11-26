/**
 * Deterministic offline fixtures.
 *
 * Everything here is data at a fixed instant: no clock, no network, no
 * filesystem. `NOW` is a literal so a golden digest recorded today still holds
 * in a year, which is the property the compiler exists to provide.
 */

import {
	createConnectivityRegistry,
	STANDARD_CONNECTIVITY,
} from "@hobo/bindings";
import {
	type CapabilityRequirement,
	type CapabilityRequirementInput,
	createCapabilityProfileRegistry,
	parseCapabilityRequirement,
	type SelectionCandidate,
	STANDARD_CAPABILITY_PROFILES,
} from "@hobo/capability-profiles";
import {
	computeEvidenceDigest,
	type EvidenceVerifier,
	parseTrustEvidence,
	parseTrustRequirement,
	sha256Of,
	type TrustEvidence,
	type TrustRequirement,
} from "@hobo/trust";

import {
	type BindleCapabilityRequest,
	type CompileRecipeInput,
	DEFAULT_RECIPE_POLICY,
	type DeploymentRequest,
	type OfferSigner,
	parseDeploymentRequest,
	parseRecipePolicy,
	type RecipePolicy,
	type RecipePolicyInput,
	type SolutionRecipe,
} from "../src/index.js";

/** 2023-11-14T22:13:20.000Z. A literal, never `Date.now()`. */
export const NOW = 1_700_000_000_000;

const DAY = 24 * 60 * 60 * 1000;

export const registry = createCapabilityProfileRegistry(
	STANDARD_CAPABILITY_PROFILES,
);
export const connectivity = createConnectivityRegistry(STANDARD_CONNECTIVITY);

type ProductSeed = {
	readonly definitionId: string;
	readonly providerId: string;
	readonly profiles: readonly string[];
	readonly runtimeModels: readonly SelectionCandidate["runtimeModels"][number][];
	readonly producesBindingProfiles: readonly string[];
	readonly providerClass?: SelectionCandidate["providerClass"];
	readonly claimAtomicity?: SelectionCandidate["claimAtomicity"];
	readonly claimActionCount?: number;
	readonly creatorAuthorityAfterClaim?: SelectionCandidate["creatorAuthorityAfterClaim"];
	readonly supportsExport?: boolean;
	readonly migrationProfiles?: readonly string[];
};

const PRODUCT_SEEDS: readonly ProductSeed[] = [
	{
		definitionId: "cloudflare.temporary-workers-api/v1",
		providerId: "cloudflare",
		profiles: ["api.http/v1", "webhook.inbound-http/v1"],
		runtimeModels: ["serverless_faas", "wasm"],
		producesBindingProfiles: ["binding.http/v1"],
		providerClass: "established",
	},
	{
		definitionId: "cloudflare.temporary-kv/v1",
		providerId: "cloudflare",
		profiles: ["kv.key-value/v1"],
		runtimeModels: ["serverless_faas", "wasm"],
		producesBindingProfiles: ["binding.http/v1"],
		providerClass: "established",
	},
	{
		definitionId: "cloudflare.temporary-workers-web/v1",
		providerId: "cloudflare",
		profiles: ["web.static/v1", "web.hosted/v1"],
		runtimeModels: ["serverless_faas"],
		producesBindingProfiles: ["binding.http/v1"],
		providerClass: "established",
	},
	{
		definitionId: "vercel.sponsored-api/v1",
		providerId: "vercel",
		profiles: ["api.http/v1", "web.ssr/v1"],
		runtimeModels: ["serverless_faas", "paas"],
		producesBindingProfiles: ["binding.http/v1"],
		providerClass: "established",
		claimAtomicity: "provider-bundled",
		creatorAuthorityAfterClaim: "reauthorization-required",
	},
	{
		definitionId: "netlify.anonymous-static-site/v1",
		providerId: "netlify",
		profiles: ["web.static/v1", "web.hosted/v1"],
		// Mirrors what @hobo/provider-netlify declares: the anonymous surface
		// publishes static assets and is not a function runtime.
		runtimeModels: ["paas"],
		producesBindingProfiles: ["binding.http/v1"],
		providerClass: "established",
	},
	{
		definitionId: "neon.claimable-postgres/v1",
		providerId: "neon",
		profiles: ["data.postgres/v1"],
		runtimeModels: ["serverless_faas", "paas", "oci", "vm_iaas"],
		producesBindingProfiles: [
			"binding.neon-serverless/v1",
			"binding.postgresql/v1",
		],
		migrationProfiles: ["migration.postgres-dump/v1"],
	},
	{
		definitionId: "prisma.claimable-postgres/v1",
		providerId: "prisma",
		profiles: ["data.postgres/v1"],
		runtimeModels: ["serverless_faas", "paas", "oci", "vm_iaas"],
		producesBindingProfiles: ["binding.postgresql/v1"],
		claimAtomicity: "provider-bundled",
		migrationProfiles: ["migration.postgres-dump/v1"],
	},
	{
		definitionId: "upstash.temporary-redis/v1",
		providerId: "upstash",
		profiles: ["kv.redis-compatible/v1"],
		runtimeModels: ["serverless_faas", "paas", "oci", "vm_iaas"],
		producesBindingProfiles: [
			"binding.redis-protocol/v1",
			"binding.redis-rest/v1",
		],
	},
	{
		definitionId: "convex.local-accountless/v1",
		providerId: "convex",
		profiles: ["data.convex/v1"],
		runtimeModels: ["oci"],
		producesBindingProfiles: ["binding.convex/v1"],
		claimActionCount: 0,
		creatorAuthorityAfterClaim: "absent",
		supportsExport: false,
	},
	{
		definitionId: "convex.selfhosted-oci/v1",
		providerId: "convex",
		profiles: ["data.convex/v1"],
		runtimeModels: ["oci"],
		producesBindingProfiles: ["binding.convex/v1"],
		creatorAuthorityAfterClaim: "absent",
	},
	{
		definitionId: "convex.cloud-sponsored-transfer/v1",
		providerId: "convex",
		profiles: ["data.convex/v1"],
		runtimeModels: ["serverless_faas"],
		producesBindingProfiles: ["binding.convex/v1"],
		claimAtomicity: "provider-bundled",
		claimActionCount: 2,
		creatorAuthorityAfterClaim: "reauthorization-required",
	},
];

function toCandidate(seed: ProductSeed): SelectionCandidate {
	return {
		definitionId: seed.definitionId,
		providerId: seed.providerId,
		implementsProfiles: seed.profiles.map((profileId) => ({
			profileId,
			versionRange: ">=1",
			realization: "native" as const,
			conformanceRef: `conformance/${seed.definitionId}/${profileId}`,
			conformance: "pass" as const,
		})),
		runtimeModels: seed.runtimeModels,
		structuredCapabilities: {},
		producesBindingProfiles: seed.producesBindingProfiles,
		migrationProfiles: seed.migrationProfiles ?? [],
		providerClass: seed.providerClass ?? "verified-emerging",
		evidenceExpiresAtMs: NOW + 30 * DAY,
		evidenceSignatureValid: true,
		creatorAuthorityAfterClaim: seed.creatorAuthorityAfterClaim ?? "rotatable",
		claimAtomicity: seed.claimAtomicity ?? "single-resource",
		claimActionCount: seed.claimActionCount ?? 1,
		continuity: {
			endpoint: "rebound",
			data: "preserved",
			credentials: "rotated",
		},
		supportsExport: seed.supportsExport ?? true,
		supportsRotation: true,
		supportsRevocation: true,
		sponsorExposureMinorUnits: 0,
		hasRegisteredDriver: true,
		secretCustodyAvailable: true,
	};
}

export const CATALOG: readonly SelectionCandidate[] =
	PRODUCT_SEEDS.map(toCandidate);

/**
 * Stands in for `profileCatalogHash` from `@hobo/cloud`.
 *
 * This package does not own a catalog, so the tests do what a caller does:
 * hand the compiler a snapshot and the digest its owner computed for it.
 */
export function catalogDigestOf(
	candidates: readonly SelectionCandidate[],
): string {
	return sha256Of(
		[...candidates]
			.map((candidate) => ({
				definitionId: candidate.definitionId,
				providerId: candidate.providerId,
				profiles: candidate.implementsProfiles
					.map((entry) => entry.profileId)
					.sort(),
				producesBindingProfiles: [...candidate.producesBindingProfiles].sort(),
			}))
			.sort((a, b) => a.definitionId.localeCompare(b.definitionId)),
	);
}

export const CATALOG_DIGEST = catalogDigestOf(CATALOG);

/** A product nobody's recipe prefers, priced to tempt a weighted scorer. */
export const CHEAP_INCOMPATIBLE_CANDIDATE: SelectionCandidate = {
	...toCandidate({
		definitionId: "bargain.postgres/v1",
		providerId: "bargain",
		profiles: ["data.postgres/v1"],
		runtimeModels: ["serverless_faas", "oci"],
		producesBindingProfiles: ["binding.postgresql/v1"],
	}),
	// Cheapest possible on every axis a score would reward, and gated on the
	// one axis that is not negotiable.
	providerClass: "experimental",
	claimActionCount: 0,
	sponsorExposureMinorUnits: 0,
};

export const PROFILE_REGISTRY_DIGEST = registry.digest;

export const TRUST_REQUIREMENT: TrustRequirement = parseTrustRequirement({
	minimumProviderClass: "verified-emerging",
	requireOfficialBootstrapContract: true,
	requireDocumentedClaimContract: true,
	creatorAuthorityAfterClaim: "must-be-rotatable",
	maximumClaimActions: 2,
	maximumEvidenceAgeMs: 30 * DAY,
	allowSponsor: true,
	allowPack: true,
	allowBridge: false,
});

function evidenceFor(seed: ProductSeed): TrustEvidence {
	const body = {
		schemaVersion: "hobo.trust-evidence/v1",
		providerId: seed.providerId,
		productDefinitionId: seed.definitionId,
		adapterVersion: "1.0.0",
		providerClass: seed.providerClass ?? ("verified-emerging" as const),
		testedAt: NOW - DAY,
		expiresAt: NOW + 30 * DAY,
		checks: {
			"bootstrap.official-contract": "pass" as const,
			"claim.documented-contract": "pass" as const,
			"conformance.suite": "pass" as const,
			"credential.rotation": "pass" as const,
			"portability.standard-binding": "pass" as const,
		},
		creatorAuthorityAfterClaim:
			seed.creatorAuthorityAfterClaim ?? ("rotatable" as const),
		claimActionCount: seed.claimActionCount ?? 1,
		realizations: ["native" as const],
		sponsorBacked: false,
		evidenceDigest:
			"sha256:0000000000000000000000000000000000000000000000000000000000000000",
		signature: `signature/${seed.definitionId}`,
		sourceRefs: [
			{
				url: `https://example.invalid/${seed.providerId}`,
				checkedAt: "2026-08-08",
			},
		],
	} as const;
	return parseTrustEvidence({
		...body,
		evidenceDigest: computeEvidenceDigest(body),
	});
}

export const EVIDENCE: readonly TrustEvidence[] =
	PRODUCT_SEEDS.map(evidenceFor);

/** A trust root that vouches for the fixture signatures and nothing else. */
export const VERIFIER: EvidenceVerifier = {
	id: "hobo.test-trust-root/v1",
	verify(request) {
		return request.signature === `signature/${request.productDefinitionId}`
			? "valid"
			: "invalid";
	},
};

export const SIGNER: OfferSigner = {
	algorithm: "test.detached-digest/v1",
	keyId: "test-key-1",
	sign(payloadDigest) {
		// Deterministic and obviously not cryptography: the offer tests are
		// about binding, not about a signature scheme this package does not own.
		return `sig:${payloadDigest.slice("sha256:".length, "sha256:".length + 16)}`;
	},
};

export function policyWith(
	overrides: Partial<RecipePolicyInput> = {},
): RecipePolicy {
	return parseRecipePolicy({
		maximumProviderCount: 2,
		maximumClaimActions: 2,
		maximumSponsoredCostMinorUnits: 0,
		minimumClaimWindowMs: 60 * 60 * 1000,
		maximumEvidenceAgeMs: 30 * DAY,
		...overrides,
	});
}

/** Per-recipe policy ceilings an operator would have to raise deliberately. */
export function policyForRecipe(recipe: SolutionRecipe): RecipePolicy {
	const providerCount = new Set(recipe.yards.map((yard) => yard.providerId))
		.size;
	const claimActions = recipe.placements.reduce(
		(total, placement) => total + placement.claim.actionCount,
		0,
	);
	const sponsored = recipe.bootstrap.sponsoredCostCapMinorUnits;
	if (providerCount <= 2 && claimActions <= 2 && sponsored === 0) {
		return DEFAULT_RECIPE_POLICY;
	}
	return policyWith({
		maximumProviderCount: Math.max(2, providerCount),
		maximumClaimActions: Math.max(2, claimActions),
		maximumSponsoredCostMinorUnits: sponsored,
	});
}

export function requirementFor(
	profileId: string,
	overrides: Partial<CapabilityRequirementInput> = {},
): CapabilityRequirement {
	return parseCapabilityRequirement({
		requiredProfiles: [{ profileId, versionRange: ">=1" }],
		...overrides,
	});
}

/** A Bindle capability slot. The primitive comes from the profile registry. */
export function capabilityFor(
	capabilityRef: string,
	profileId: string,
	overrides: Partial<CapabilityRequirementInput> = {},
): BindleCapabilityRequest {
	return {
		capabilityRef,
		primitive: registry.require(profileId).primitive,
		requirement: requirementFor(profileId, overrides),
	};
}

/**
 * The request a recipe claims to answer.
 *
 * Derived from the recipe so a golden fixture asserts "this recipe satisfies
 * the ask it advertises". Mismatch and downgrade cases build their requests by
 * hand instead.
 */
export function requestForRecipe(recipe: SolutionRecipe): DeploymentRequest {
	return parseDeploymentRequest({
		deploymentRef: `junction/${recipe.id.replace(/[/.]/gu, "-")}`,
		capabilities: recipe.placements.map((placement) =>
			capabilityFor(
				placement.capabilityRef,
				placement.satisfiesProfileId,
				placement.runtimeModel === undefined
					? {}
					: { runtime: { allowed: [placement.runtimeModel] } },
			),
		),
		dependencies: recipe.edges.map((edge) => {
			const from = recipe.placements.find(
				(placement) => placement.placementId === edge.fromPlacementId,
			);
			const to = recipe.placements.find(
				(placement) => placement.placementId === edge.toPlacementId,
			);
			return {
				fromCapabilityRef: from?.capabilityRef ?? edge.fromPlacementId,
				toCapabilityRef: to?.capabilityRef ?? edge.toPlacementId,
			};
		}),
		requestedSemantics: recipe.delivers,
	});
}

export function compileInputFor(
	recipe: SolutionRecipe,
	overrides: Partial<CompileRecipeInput> = {},
): CompileRecipeInput {
	return {
		recipe,
		request: requestForRecipe(recipe),
		registry,
		catalog: CATALOG,
		catalogDigest: CATALOG_DIGEST,
		connectivity,
		policy: policyForRecipe(recipe),
		trustRequirement: TRUST_REQUIREMENT,
		evidence: EVIDENCE,
		verifier: VERIFIER,
		nowMs: NOW,
		...overrides,
	};
}
