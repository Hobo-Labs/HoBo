/**
 * The deterministic recipe compiler.
 *
 * Pure by construction: no clock, no network, no randomness, no environment,
 * no filesystem. The evaluation instant, the catalog snapshot, the evidence
 * snapshot, and the policy are all arguments, which is what makes a compiled
 * offer replayable years later and a signature over it meaningful.
 *
 * It builds no second matcher either — per-placement gating runs through
 * `selectCapabilityImplementation` from `@hobo/capability-profiles`, narrowed
 * to the product the recipe prefers.
 */

import type { ConnectivityRegistry } from "@hobo/bindings";
import type {
	CapabilityProfileRegistry,
	ProfileImplementation,
	RealizationKind,
	RejectionCode,
	SelectionCandidate,
} from "@hobo/capability-profiles";
import { selectCapabilityImplementation } from "@hobo/capability-profiles";
import type { ClaimAtomicity, Instant } from "@hobo/claims";
import type {
	CanonicalValue,
	EvidenceVerifier,
	TrustEvidence,
	TrustRequirement,
} from "@hobo/trust";
import { DIGEST_PATTERN, evaluateTrustBundle, sha256Of } from "@hobo/trust";

import type { RecipeId } from "./ids.js";
import type { RecipePolicy } from "./policy.js";
import type {
	RecipeConnectivityChoice,
	RecipePlacement,
	SolutionRecipe,
} from "./recipe.js";
import type { BindleCapabilityRequest, DeploymentRequest } from "./request.js";
import {
	claimFactsBody,
	type DerivedClaimFacts,
	type DerivedClaimItem,
	type DerivedGuestLease,
	guestLeasesBody,
	type PortabilitySummary,
	portabilityBody,
	RESOLVED_TOPOLOGY_SCHEMA_VERSION,
	type ResolvedBinding,
	type ResolvedCamp,
	type ResolvedResource,
	type ResolvedTopology,
	type ResolvedYard,
	topologyDigestBody,
} from "./topology.js";
import {
	detectProfileWidening,
	detectRealizationWidening,
	detectSemanticWidenings,
	sortWidenings,
	type WideningNotice,
} from "./widening.js";

export type RecipeRejection = {
	readonly code: RejectionCode;
	readonly detail: string;
	readonly placementId?: string;
	readonly capabilityRef?: string;
};

export type CompileRecipeInput = {
	readonly recipe: SolutionRecipe;
	readonly request: DeploymentRequest;
	readonly registry: CapabilityProfileRegistry;
	/**
	 * A snapshot of the product catalog projected into selection shape.
	 * `@hobo/cloud` produces these with `toSelectionCandidate`; this package
	 * deliberately owns no catalog of its own.
	 */
	readonly catalog: readonly SelectionCandidate[];
	/** Digest of that catalog, supplied by its owner (`profileCatalogHash`). */
	readonly catalogDigest: string;
	readonly connectivity: ConnectivityRegistry;
	readonly policy: RecipePolicy;
	readonly trustRequirement: TrustRequirement;
	readonly evidence: readonly TrustEvidence[];
	readonly verifier?: EvidenceVerifier;
	/** Canonical evaluation instant. The compiler never reads a clock. */
	readonly nowMs: number;
};

export type RecipeCompilationAccepted = {
	readonly ok: true;
	readonly recipeId: RecipeId;
	readonly topology: ResolvedTopology;
	readonly topologyDigest: string;
	readonly resolutionDigest: string;
	readonly claims: DerivedClaimFacts;
	readonly guestLeases: readonly DerivedGuestLease[];
	readonly portability: PortabilitySummary;
	/** Permitted downgrades. Every one of these must reach the offer. */
	readonly widenings: readonly WideningNotice[];
	readonly trustEvidenceRefs: readonly string[];
	readonly conformanceEvidenceRefs: readonly string[];
	readonly sponsoredCostMinorUnits: number;
	readonly rejections: readonly RecipeRejection[];
};

export type RecipeCompilationRejected = {
	readonly ok: false;
	readonly recipeId: RecipeId;
	readonly rejections: readonly RecipeRejection[];
};

export type RecipeCompilation =
	| RecipeCompilationAccepted
	| RecipeCompilationRejected;

export class RecipeCompileError extends Error {
	readonly code = "INVALID_COMPILE_INPUT" as const;

	constructor(message: string) {
		super(message);
		this.name = "RecipeCompileError";
	}
}

const ATOMICITY_RANK = {
	"single-resource": 0,
	"provider-bundled": 1,
	"best-effort-saga": 2,
} as const;

const ATOMICITY_BY_RANK: readonly ClaimAtomicity[] = [
	"single-resource",
	"provider-bundled",
	"best-effort-saga",
];

function sortRejections(
	rejections: readonly RecipeRejection[],
): readonly RecipeRejection[] {
	return [...rejections].sort(
		(a, b) =>
			(a.placementId ?? "").localeCompare(b.placementId ?? "") ||
			a.code.localeCompare(b.code) ||
			a.detail.localeCompare(b.detail),
	);
}

function implementationFor(
	candidate: SelectionCandidate,
	requiredProfileId: string,
	registry: CapabilityProfileRegistry,
): ProfileImplementation | undefined {
	const matches = candidate.implementsProfiles
		.filter((implementation) =>
			registry.satisfies(implementation.profileId, requiredProfileId),
		)
		// Deterministic when a product implements both a profile and its child.
		.sort((a, b) => a.profileId.localeCompare(b.profileId));
	return matches[0];
}

/** Compile a recipe against a request. Pure; every effect belongs downstream. */
export function compileRecipe(input: CompileRecipeInput): RecipeCompilation {
	if (!Number.isInteger(input.nowMs)) {
		throw new RecipeCompileError(
			"nowMs must be an integer epoch-millisecond instant",
		);
	}
	if (!DIGEST_PATTERN.test(input.catalogDigest)) {
		throw new RecipeCompileError(
			"catalogDigest must be a lowercase sha256:<hex> digest",
		);
	}

	const { recipe, request, registry, policy } = input;
	const rejections: RecipeRejection[] = [];
	const widenings: WideningNotice[] = [];
	const reject = (rejection: RecipeRejection): void => {
		rejections.push(rejection);
	};

	// Sorting the catalog first makes lookup order independent of registration
	// order, which the metamorphic tests assert.
	const catalogById = new Map<string, SelectionCandidate>();
	for (const candidate of [...input.catalog].sort((a, b) =>
		a.definitionId.localeCompare(b.definitionId),
	)) {
		catalogById.set(candidate.definitionId, candidate);
	}

	const capabilityByRef = new Map<string, BindleCapabilityRequest>();
	for (const capability of request.capabilities) {
		capabilityByRef.set(capability.capabilityRef, capability);
	}
	const placementByCapability = new Map<string, RecipePlacement>();
	const yardById = new Map(recipe.yards.map((yard) => [yard.yardId, yard]));

	// Gate 1: the recipe must cover every required capability exactly once and
	// invent none. Recipe parsing already rejects a duplicate inside one recipe.
	for (const placement of recipe.placements) {
		placementByCapability.set(placement.capabilityRef, placement);
		if (!capabilityByRef.has(placement.capabilityRef)) {
			reject({
				code: "PROFILE_INCOMPATIBLE",
				detail: `covers capability ${placement.capabilityRef} which the bindle does not declare`,
				placementId: placement.placementId,
				capabilityRef: placement.capabilityRef,
			});
		}
	}
	for (const capability of request.capabilities) {
		if (!placementByCapability.has(capability.capabilityRef)) {
			reject({
				code: "PROFILE_INCOMPATIBLE",
				detail: `leaves required capability ${capability.capabilityRef} unplaced`,
				capabilityRef: capability.capabilityRef,
			});
		}
	}

	// Gate 2: every placement resolves to a compatible, policy-admissible
	// product. The consumable binding profiles come from the incoming edges so
	// a producer nobody can consume is caught here rather than at deploy time.
	const consumableByPlacement = new Map<string, Set<string>>();
	for (const edge of recipe.edges) {
		const profiles =
			consumableByPlacement.get(edge.toPlacementId) ?? new Set<string>();
		profiles.add(edge.primary.bindingProfileRef);
		for (const fallback of edge.fallbacks)
			profiles.add(fallback.bindingProfileRef);
		consumableByPlacement.set(edge.toPlacementId, profiles);
	}

	const resourceByPlacement = new Map<string, ResolvedResource>();
	const candidateByPlacement = new Map<string, SelectionCandidate>();
	for (const placement of recipe.placements) {
		const capability = capabilityByRef.get(placement.capabilityRef);
		if (capability === undefined) continue;
		const yard = yardById.get(placement.yardId);
		if (yard === undefined) continue;

		// The Bindle names the primitive; a recipe may choose the product but
		// never reinterpret a queue slot as a bucket.
		if (capability.primitive !== placement.primitive) {
			reject({
				code: "PROFILE_INCOMPATIBLE",
				detail: `capability ${capability.capabilityRef} is a ${capability.primitive} slot but the placement provisions a ${placement.primitive}`,
				placementId: placement.placementId,
				capabilityRef: placement.capabilityRef,
			});
			continue;
		}

		const candidate = catalogById.get(placement.productDefinitionId);
		if (candidate === undefined) {
			reject({
				code: "NO_REGISTERED_DRIVER",
				detail: `product ${placement.productDefinitionId} is absent from the catalog snapshot`,
				placementId: placement.placementId,
				capabilityRef: placement.capabilityRef,
			});
			continue;
		}
		// The provider boundary must be explicit: a product from another
		// provider inside this Yard is an ownership boundary nobody declared.
		if (candidate.providerId !== yard.providerId) {
			reject({
				code: "ARCHITECTURE_UNSUPPORTED",
				detail: `product ${candidate.definitionId} belongs to provider ${candidate.providerId} but is placed in ${yard.providerId} yard ${yard.yardId}`,
				placementId: placement.placementId,
				capabilityRef: placement.capabilityRef,
			});
			continue;
		}
		if (
			placement.runtimeModel !== undefined &&
			!candidate.runtimeModels.includes(placement.runtimeModel)
		) {
			reject({
				code: "RUNTIME_UNSUPPORTED",
				detail: `product ${candidate.definitionId} does not support runtime ${placement.runtimeModel}`,
				placementId: placement.placementId,
				capabilityRef: placement.capabilityRef,
			});
			continue;
		}

		const consumable = consumableByPlacement.get(placement.placementId);
		const selection = selectCapabilityImplementation({
			requirement: capability.requirement,
			registry,
			candidates: [candidate],
			policy: policy.trust,
			nowMs: input.nowMs,
			...(consumable !== undefined
				? {
						consumableBindingProfiles: [...consumable].sort((a, b) =>
							a.localeCompare(b),
						),
					}
				: undefined),
		});
		if (selection.winner === undefined) {
			for (const rejection of selection.rejections) {
				reject({
					code: rejection.code,
					detail: `${rejection.definitionId}: ${rejection.detail}`,
					placementId: placement.placementId,
					capabilityRef: placement.capabilityRef,
				});
			}
			continue;
		}

		// No silent weakening of the required profile.
		widenings.push(
			...detectProfileWidening({
				requirement: capability.requirement,
				satisfiesProfileId: placement.satisfiesProfileId,
				registry,
				placementId: placement.placementId,
			}),
		);

		const primaryRequired = capability.requirement.requiredProfiles[0];
		const implementation =
			primaryRequired === undefined
				? undefined
				: implementationFor(candidate, primaryRequired.profileId, registry);
		if (implementation !== undefined) {
			widenings.push(
				...detectRealizationWidening({
					requirement: capability.requirement,
					implementation,
					placementId: placement.placementId,
				}),
			);
		}

		const realization: RealizationKind =
			implementation?.realization ?? "native";
		const resource: ResolvedResource = {
			resourceRef: `${request.deploymentRef}/${placement.yardId}/${placement.placementId}`,
			placementId: placement.placementId,
			capabilityRef: placement.capabilityRef,
			primitive: placement.primitive,
			satisfiesProfileId: placement.satisfiesProfileId,
			productDefinitionId: placement.productDefinitionId,
			realization,
			...(placement.runtimeModel !== undefined
				? { runtimeModel: placement.runtimeModel }
				: undefined),
			producesBindingProfiles: [...candidate.producesBindingProfiles].sort(
				(a, b) => a.localeCompare(b),
			),
		};
		resourceByPlacement.set(placement.placementId, resource);
		candidateByPlacement.set(placement.placementId, candidate);
	}

	// Gate 3: every required product carries fresh, signed, non-failed evidence.
	const requiredProducts = [
		...new Set(
			recipe.placements.map((placement) => placement.productDefinitionId),
		),
	].sort((a, b) => a.localeCompare(b));
	const evidenceByProduct = new Map(
		input.evidence.map((record) => [record.productDefinitionId, record]),
	);
	const trustBundle = evaluateTrustBundle({
		subjects: requiredProducts.map((productDefinitionId) => {
			const record = evidenceByProduct.get(productDefinitionId);
			return {
				subjectId: productDefinitionId,
				...(record !== undefined ? { evidence: record } : undefined),
			};
		}),
		requirement: input.trustRequirement,
		nowMs: input.nowMs,
		...(input.verifier !== undefined
			? { verifier: input.verifier }
			: undefined),
	});
	for (const reason of trustBundle.reasons) {
		// The three trust-only reasons all mean the same thing to a compiler:
		// there is no usable evidence for this product.
		const code: RejectionCode =
			reason.code === "EVIDENCE_ABSENT" ||
			reason.code === "EVIDENCE_UNSIGNED" ||
			reason.code === "EVIDENCE_DIGEST_MISMATCH"
				? "EVIDENCE_STALE"
				: reason.code;
		reject({ code, detail: `${reason.subjectId}: ${reason.detail}` });
	}

	// Gate 4: every declared edge resolves to a connectivity implementation the
	// consumer's runtime can actually use, and the producer emits its binding.
	const bindings: ResolvedBinding[] = [];
	for (const edge of recipe.edges) {
		const consumer = recipe.placements.find(
			(placement) => placement.placementId === edge.fromPlacementId,
		);
		const producer = recipe.placements.find(
			(placement) => placement.placementId === edge.toPlacementId,
		);
		const consumerResource = resourceByPlacement.get(edge.fromPlacementId);
		const producerResource = resourceByPlacement.get(edge.toPlacementId);
		const producerCandidate = candidateByPlacement.get(edge.toPlacementId);
		if (
			consumer === undefined ||
			producer === undefined ||
			consumerResource === undefined ||
			producerResource === undefined ||
			producerCandidate === undefined
		) {
			// The placement itself already failed; a second rejection for the
			// edge would be noise.
			continue;
		}
		const consumerYard = yardById.get(consumer.yardId);
		if (consumerYard === undefined) continue;
		if (consumer.runtimeModel === undefined) {
			reject({
				code: "RUNTIME_UNSUPPORTED",
				detail: `edge ${edge.edgeId} consumer ${consumer.placementId} declares no runtime model, so no connectivity implementation can be resolved`,
				placementId: consumer.placementId,
			});
			continue;
		}

		const choices: readonly RecipeConnectivityChoice[] = [
			edge.primary,
			...edge.fallbacks,
		];
		let selected:
			| { choice: RecipeConnectivityChoice; index: number }
			| undefined;
		const failures: string[] = [];
		for (const [index, choice] of choices.entries()) {
			if (
				!producerCandidate.producesBindingProfiles.includes(
					choice.bindingProfileRef,
				)
			) {
				failures.push(
					`${choice.connectivityImplementationId} needs ${choice.bindingProfileRef} which ${producerCandidate.definitionId} does not produce`,
				);
				continue;
			}
			const resolved = input.connectivity.resolve({
				bindingProfileRef: choice.bindingProfileRef,
				runtimeModel: consumer.runtimeModel,
				providerId: consumerYard.providerId,
			});
			if (
				!resolved.some(
					(implementation) =>
						implementation.id === choice.connectivityImplementationId,
				)
			) {
				failures.push(
					`${choice.connectivityImplementationId} is not registered for ${choice.bindingProfileRef} on ${consumer.runtimeModel}/${consumerYard.providerId}`,
				);
				continue;
			}
			selected = { choice, index };
			break;
		}
		if (selected === undefined) {
			reject({
				code: "BINDING_UNAVAILABLE",
				detail: `edge ${edge.edgeId} has no usable connectivity implementation: ${failures.join("; ")}`,
				placementId: consumer.placementId,
			});
			continue;
		}
		bindings.push({
			edgeId: edge.edgeId,
			fromResourceRef: consumerResource.resourceRef,
			toResourceRef: producerResource.resourceRef,
			bindingProfileRef: selected.choice.bindingProfileRef,
			connectivityImplementationId:
				selected.choice.connectivityImplementationId,
			crossYard: consumer.yardId !== producer.yardId,
			usedFallback: selected.index > 0,
		});
	}

	// Gate 5: every declared dependency that crosses a Yard has an edge. A
	// cross-provider hop nobody wired is the failure this catches.
	const edgeByPair = new Set(
		recipe.edges.map(
			(edge) => `${edge.fromPlacementId}\u0000${edge.toPlacementId}`,
		),
	);
	for (const dependency of request.dependencies) {
		const consumer = placementByCapability.get(dependency.fromCapabilityRef);
		const producer = placementByCapability.get(dependency.toCapabilityRef);
		if (consumer === undefined || producer === undefined) continue;
		if (edgeByPair.has(`${consumer.placementId}\u0000${producer.placementId}`))
			continue;
		if (consumer.yardId === producer.yardId) continue;
		reject({
			code: "BINDING_UNAVAILABLE",
			detail: `dependency ${dependency.fromCapabilityRef} → ${dependency.toCapabilityRef} crosses yards ${consumer.yardId} → ${producer.yardId} with no declared connectivity edge`,
			placementId: consumer.placementId,
		});
	}

	// Gate 6: whole-solution claim, cost, and disclosure ceilings.
	const claims = deriveClaimFacts(
		recipe,
		resourceByPlacement,
		yardById,
		input.nowMs,
	);
	if (claims.actionCount > policy.maximumClaimActions) {
		reject({
			code: "TOO_MANY_CLAIM_ACTIONS",
			detail: `${claims.actionCount} human claim actions exceeds the policy maximum ${policy.maximumClaimActions}`,
		});
	}
	const providerIds = [
		...new Set(recipe.yards.map((yard) => yard.providerId)),
	].sort((a, b) => a.localeCompare(b));
	if (providerIds.length > policy.maximumProviderCount) {
		reject({
			code: "ARCHITECTURE_UNSUPPORTED",
			detail: `spans ${providerIds.length} provider boundaries (${providerIds.join(", ")}), policy allows ${policy.maximumProviderCount}`,
		});
	}
	if (
		claims.earliestDeadlineMs !== undefined &&
		claims.earliestDeadlineMs - input.nowMs < policy.minimumClaimWindowMs
	) {
		reject({
			code: "CLAIM_MODE_INSUFFICIENT",
			detail: `the earliest claim deadline leaves ${claims.earliestDeadlineMs - input.nowMs}ms, below the ${policy.minimumClaimWindowMs}ms minimum window`,
		});
	}

	let sponsoredCostMinorUnits = recipe.bootstrap.sponsoredCostCapMinorUnits;
	for (const candidate of candidateByPlacement.values()) {
		sponsoredCostMinorUnits += candidate.sponsorExposureMinorUnits;
	}
	if (sponsoredCostMinorUnits > policy.maximumSponsoredCostMinorUnits) {
		reject({
			code: "SPONSOR_BUDGET_EXCEEDED",
			detail: `sponsored exposure ${sponsoredCostMinorUnits} exceeds the policy cap ${policy.maximumSponsoredCostMinorUnits}`,
		});
	}
	// A recipe that deploys no code has no source to disclose; only a recipe
	// that runs something owes the caller an answer about what it runs.
	const deploysSource = recipe.placements.some(
		(placement) => placement.runtimeModel !== undefined,
	);
	if (
		policy.requireSourceDisclosure &&
		deploysSource &&
		recipe.bootstrap.sourceDisclosure === "not-applicable"
	) {
		reject({
			code: "SOURCE_DISCLOSURE_DENIED",
			detail:
				"policy requires the recipe to disclose whether deployed source is public",
		});
	}

	// Gate 7: no silent widening. A downgrade is only survivable when policy
	// explicitly permits it; permitted ones then have to reach the offer.
	widenings.push(
		...detectSemanticWidenings(request.requestedSemantics, recipe.delivers),
	);
	const allowed = new Set(policy.allowedWidenings);
	const sortedWidenings = sortWidenings(widenings);
	for (const notice of sortedWidenings) {
		if (allowed.has(notice.kind)) continue;
		reject({
			code: notice.rejectionCode,
			detail: `${notice.kind}: ${notice.detail} — policy does not permit this widening`,
			...(notice.placementId !== undefined
				? { placementId: notice.placementId }
				: undefined),
		});
	}

	if (rejections.length > 0) {
		return {
			ok: false,
			recipeId: recipe.id,
			rejections: sortRejections(rejections),
		};
	}

	const topology = buildTopology(
		recipe,
		request,
		resourceByPlacement,
		bindings,
	);
	const guestLeases = deriveGuestLeases(recipe, request, input.nowMs);
	const portability = derivePortability(
		recipe,
		candidateByPlacement,
		providerIds.length,
	);
	const topologyDigest = sha256Of(topologyDigestBody(topology));
	const resolutionDigest = sha256Of(
		resolutionDigestBody({
			topologyDigest,
			recipeId: recipe.id,
			deploymentRef: request.deploymentRef,
			profileRegistryDigest: registry.digest,
			claims,
			guestLeases,
			portability,
			widenings: sortedWidenings,
			sponsoredCostMinorUnits,
			trustBundleDigest: trustBundle.bundleDigest,
		}),
	);

	return {
		ok: true,
		recipeId: recipe.id,
		topology,
		topologyDigest,
		resolutionDigest,
		claims,
		guestLeases,
		portability,
		widenings: sortedWidenings,
		trustEvidenceRefs: trustBundle.subjects.map(
			(subject) => `${subject.subjectId}#${subject.verdict.verdictDigest}`,
		),
		conformanceEvidenceRefs: conformanceRefs(
			recipe,
			candidateByPlacement,
			registry,
		),
		sponsoredCostMinorUnits,
		rejections: [],
	};
}

function resolutionDigestBody(args: {
	readonly topologyDigest: string;
	readonly recipeId: RecipeId;
	readonly deploymentRef: string;
	readonly profileRegistryDigest: string;
	readonly claims: DerivedClaimFacts;
	readonly guestLeases: readonly DerivedGuestLease[];
	readonly portability: PortabilitySummary;
	readonly widenings: readonly WideningNotice[];
	readonly sponsoredCostMinorUnits: number;
	readonly trustBundleDigest: string;
}): CanonicalValue {
	// Deliberately excludes the catalog digest: an unrelated catalog addition
	// must not change a resolution that did not depend on it. The offer carries
	// the catalog digest separately, and acceptance binds to both.
	return {
		topologyDigest: args.topologyDigest,
		recipeId: args.recipeId,
		deploymentRef: args.deploymentRef,
		profileRegistryDigest: args.profileRegistryDigest,
		claims: claimFactsBody(args.claims),
		guestLeases: guestLeasesBody(args.guestLeases),
		portability: portabilityBody(args.portability),
		widenings: args.widenings.map((notice) => ({
			kind: notice.kind,
			detail: notice.detail,
			placementId: notice.placementId,
		})),
		sponsoredCostMinorUnits: args.sponsoredCostMinorUnits,
		trustBundleDigest: args.trustBundleDigest,
	};
}

function buildTopology(
	recipe: SolutionRecipe,
	request: DeploymentRequest,
	resourceByPlacement: ReadonlyMap<string, ResolvedResource>,
	bindings: readonly ResolvedBinding[],
): ResolvedTopology {
	const yards: ResolvedYard[] = [];
	for (const yard of recipe.yards) {
		const placements = recipe.placements.filter(
			(placement) => placement.yardId === yard.yardId,
		);
		const campIds = [
			...new Set(
				placements
					.map((placement) => placement.campId)
					.filter((campId): campId is string => campId !== undefined),
			),
		].sort((a, b) => a.localeCompare(b));
		const camps: ResolvedCamp[] = campIds.map((campId) => ({
			campId,
			campRef: `${request.deploymentRef}/${yard.yardId}/${campId}`,
			resources: placements
				.filter((placement) => placement.campId === campId)
				.map((placement) => resourceByPlacement.get(placement.placementId))
				.filter(
					(resource): resource is ResolvedResource => resource !== undefined,
				)
				.sort((a, b) => a.placementId.localeCompare(b.placementId)),
		}));
		const bare = placements
			.filter((placement) => placement.campId === undefined)
			.map((placement) => resourceByPlacement.get(placement.placementId))
			.filter(
				(resource): resource is ResolvedResource => resource !== undefined,
			)
			.sort((a, b) => a.placementId.localeCompare(b.placementId));
		yards.push({
			yardId: yard.yardId,
			yardRef: `${request.deploymentRef}/${yard.yardId}`,
			providerId: yard.providerId,
			resourceOnly: yard.resourceOnly,
			sponsored: yard.sponsored,
			regions: yard.regions,
			camps,
			resources: bare,
		});
	}

	return {
		schemaVersion: RESOLVED_TOPOLOGY_SCHEMA_VERSION,
		recipeId: recipe.id,
		junctionRef: request.deploymentRef,
		yards: yards.sort((a, b) => a.yardId.localeCompare(b.yardId)),
		bindings: [...bindings].sort((a, b) => a.edgeId.localeCompare(b.edgeId)),
	};
}

function deriveClaimFacts(
	recipe: SolutionRecipe,
	resourceByPlacement: ReadonlyMap<string, ResolvedResource>,
	yardById: ReadonlyMap<string, SolutionRecipe["yards"][number]>,
	nowMs: number,
): DerivedClaimFacts {
	const items: DerivedClaimItem[] = [];
	const providers = new Set<string>();
	let actionCount = 0;
	let earliestDeadlineMs: Instant | undefined;
	let worstRank = 0;

	for (const placement of recipe.placements) {
		if (placement.claim.mode === "none") continue;
		const yard = yardById.get(placement.yardId);
		const resource = resourceByPlacement.get(placement.placementId);
		if (yard === undefined || resource === undefined) continue;
		providers.add(yard.providerId);
		actionCount += placement.claim.actionCount;
		worstRank = Math.max(worstRank, ATOMICITY_RANK[placement.claim.atomicity]);
		const deadlineMs =
			placement.claim.deadlineMsFromStart === undefined
				? undefined
				: nowMs + placement.claim.deadlineMsFromStart;
		if (deadlineMs !== undefined) {
			earliestDeadlineMs =
				earliestDeadlineMs === undefined
					? deadlineMs
					: Math.min(earliestDeadlineMs, deadlineMs);
		}
		items.push({
			claimId: `claim/${placement.placementId}`,
			subjectRef: resource.resourceRef,
			subjectKind: "resource",
			providerId: yard.providerId,
			mode: placement.claim.mode,
			actionCount: placement.claim.actionCount,
			...(deadlineMs !== undefined ? { deadlineMs } : undefined),
			creatorAuthorityAfterClaim: placement.claim.creatorAuthorityAfterClaim,
			postClaimActions: [...placement.claim.postClaimActions],
		});
	}

	// One provider can bundle its own resources; two cannot. Crossing a
	// provider boundary downgrades the whole bundle to a best-effort saga,
	// which is exactly the fact a caller needs disclosed before accepting.
	const atomicity: ClaimAtomicity =
		items.length === 0
			? "single-resource"
			: providers.size > 1
				? "best-effort-saga"
				: (ATOMICITY_BY_RANK[worstRank] ?? "best-effort-saga");

	return {
		actionCount,
		providerCount: providers.size,
		atomicity,
		...(earliestDeadlineMs !== undefined ? { earliestDeadlineMs } : undefined),
		items: items.sort((a, b) => a.claimId.localeCompare(b.claimId)),
	};
}

function deriveGuestLeases(
	recipe: SolutionRecipe,
	request: DeploymentRequest,
	nowMs: number,
): readonly DerivedGuestLease[] {
	return recipe.yards
		.map((yard) => ({
			leaseId: `lease/${yard.yardId}`,
			yardId: yard.yardId,
			subjectRef: `${request.deploymentRef}/${yard.yardId}`,
			bootstrapClass: yard.lease.bootstrapClass,
			cleanupPolicy: yard.lease.cleanupPolicy,
			renewable: yard.lease.renewable,
			claimByMs: nowMs + yard.lease.claimByMsFromStart,
		}))
		.sort((a, b) => a.leaseId.localeCompare(b.leaseId));
}

function derivePortability(
	recipe: SolutionRecipe,
	candidateByPlacement: ReadonlyMap<string, SelectionCandidate>,
	providerCount: number,
): PortabilitySummary {
	const supported: string[] = [];
	const missing: string[] = [];
	const migrations = new Set<string>();
	for (const placement of recipe.placements) {
		const candidate = candidateByPlacement.get(placement.placementId);
		if (candidate === undefined) continue;
		(candidate.supportsExport ? supported : missing).push(
			placement.placementId,
		);
		for (const profile of candidate.migrationProfiles) migrations.add(profile);
	}
	return {
		providerCount,
		exportSupportedPlacements: supported.sort((a, b) => a.localeCompare(b)),
		exportMissingPlacements: missing.sort((a, b) => a.localeCompare(b)),
		migrationProfiles: [...migrations].sort((a, b) => a.localeCompare(b)),
	};
}

function conformanceRefs(
	recipe: SolutionRecipe,
	candidateByPlacement: ReadonlyMap<string, SelectionCandidate>,
	registry: CapabilityProfileRegistry,
): readonly string[] {
	const refs = new Set<string>();
	for (const placement of recipe.placements) {
		const candidate = candidateByPlacement.get(placement.placementId);
		if (candidate === undefined) continue;
		const implementation = implementationFor(
			candidate,
			placement.satisfiesProfileId,
			registry,
		);
		if (implementation !== undefined) refs.add(implementation.conformanceRef);
	}
	return [...refs].sort((a, b) => a.localeCompare(b));
}
