/**
 * Projecting a verified pack into the product catalog.
 *
 * A pack is selectable by exactly the same machinery as a managed product — it
 * produces a Resource Definition vNext semantics block and a
 * {@link SelectionCandidate} — but three facts are not negotiable and are set
 * here rather than accepted from a caller:
 *
 * - `realization` is always `"pack"`. There is no code path that lets a
 *   container on generic compute advertise itself as a provider-native managed
 *   product, so a trust policy with `allowPack: false` genuinely excludes it.
 * - the claim strategy is the pack's own ownership strategy (Yard-owned, or
 *   migrate-on-claim), never a provider account claim. There is no provider
 *   account for a container the operator started.
 * - `sponsorExposureMinorUnits` is 0. The compute is the operator's own.
 *
 * The projection reads no clock: evidence expiry and signature validity are
 * required inputs, because a package that invented its own freshness would be
 * grading its own homework.
 */
import type {
	ContinuityGrade,
	ProviderClass,
	SelectionCandidate,
} from "@hobo/capability-profiles";

import { RESOURCE_DEFINITION_VNEXT_SCHEMA } from "./constants.js";
import type { VerifiedPackManifest } from "./verification.js";

export type PackPlacementConstraint = {
	readonly key: string;
	readonly operator: "in" | "not-in" | "equals" | "exists";
	readonly values: readonly string[];
};

export type PackRemediationHint = {
	readonly code: string;
	readonly message: string;
};

export type PackSemanticsOptions = {
	/** Catalog id for this definition, e.g. `hobo.pack.postgres-oci/v1`. */
	readonly definitionId: string;
	/**
	 * The Yard (or Yard-shaped compute provider) that will run the container.
	 * This is a compute host, not the vendor of a managed product.
	 */
	readonly providerId: string;
	readonly compilerRef: string;
	readonly executorRef: string;
	readonly permissionProfileRef: string;
	readonly bootstrapStrategyRef: string;
	readonly trustEvidenceRef: string;
	/** Epoch ms after which this pack's evidence must be re-gathered. */
	readonly evidenceExpiresAtMs: number;
	/** Whether the catalog owner has signed the evidence. */
	readonly evidenceSignatureValid: boolean;
	readonly structuredCapabilities: Readonly<
		Record<string, boolean | number | string | readonly string[]>
	>;
	readonly providerClass?: ProviderClass;
	readonly placementConstraints?: readonly PackPlacementConstraint[];
	readonly remediation?: readonly PackRemediationHint[];
	readonly requiresConnectivityProfiles?: readonly string[];
	readonly sourceEvidenceRefs?: readonly string[];
	readonly secretCustodyAvailable?: boolean;
	readonly supportsRotation?: boolean;
	readonly supportsRevocation?: boolean;
};

type PackContinuity = {
	readonly endpoint: ContinuityGrade;
	readonly data: ContinuityGrade;
	readonly credentials:
		| "revoked"
		| "rotated"
		| "reauthorized"
		| "retained"
		| "unknown"
		| "not-applicable";
};

/**
 * Continuity is a property of the ownership strategy, not a marketing choice.
 *
 * Yard-owned: nothing transfers, so nothing is disturbed. Migrate-on-claim: the
 * endpoint is rebound and the data is copied, and saying anything softer than
 * that would misrepresent a migration as a no-op.
 */
function continuityFor(manifest: VerifiedPackManifest): PackContinuity {
	return manifest.ownership === "yard-owned"
		? {
				endpoint: "preserved",
				data: "preserved",
				credentials: "not-applicable",
			}
		: { endpoint: "rebound", data: "migrated", credentials: "rotated" };
}

function migrationProfilesOf(
	manifest: VerifiedPackManifest,
): readonly string[] {
	const refs = manifest.operations
		.filter(
			(operation) =>
				operation.kind === "migration" && operation.profileRef !== undefined,
		)
		// SAFETY: `.map((operation) => operation.profileRef as string);` is required at this I/O or test boundary.
		.map((operation) => operation.profileRef)
		.filter((ref): ref is string => ref !== undefined);
	return [...new Set(refs)].sort((a, b) => a.localeCompare(b));
}

/**
 * The semantics block a Yard catalog attaches to its Resource Definition.
 *
 * The return type is inferred so this package never re-declares
 * `ResourceDefinitionSemantics`; `test/resource-definition-compat.test.ts`
 * asserts structural assignability against the real type in `@hobo/cloud` and
 * runs the real `parseResourceDefinitionVNext` over the result.
 */
export function toPackResourceSemantics(
	manifest: VerifiedPackManifest,
	options: PackSemanticsOptions,
) {
	const persistent = manifest.persistence.requirement === "required";
	return {
		schemaVersion: RESOURCE_DEFINITION_VNEXT_SCHEMA,
		// SAFETY: `productId: manifest.packId as string,` is required at this I/O or test boundary.
		productId: String(manifest.packId),
		displayName: manifest.displayName,
		implementsProfiles: manifest.implementsProfiles.map((claim) => ({
			profileId: claim.profileId,
			versionRange: claim.versionRange,
			realization: "pack" as const,
			conformanceRef: claim.conformanceRef,
			conformance: claim.conformance,
		})),
		runtimeModels: manifest.runtimeModels,
		structuredCapabilities: {
			...options.structuredCapabilities,
			// Pack-intrinsic facts a catalog can rank and gate on. They are set
			// from the verified manifest, so a pack cannot overstate them.
			packRealization: "pack",
			// SAFETY: `packId: manifest.packId as string,` is required at this I/O or test boundary.
			packId: String(manifest.packId),
			// SAFETY: `packVersion: manifest.packVersion as string,` is required at this I/O or test boundary.
			packVersion: String(manifest.packVersion),
			imageDigestPinned: true,
			imageArchitectures: manifest.images.map((image) => image.architecture),
			persistenceRequired: persistent,
			packOwnership: manifest.ownership,
			managedProviderClaim: false,
		},
		placementConstraints: options.placementConstraints ?? [],
		producesBindingProfiles: manifest.producesBindingProfiles,
		...(options.requiresConnectivityProfiles !== undefined
			? { requiresConnectivityProfiles: options.requiresConnectivityProfiles }
			: undefined),
		migrationProfiles: migrationProfilesOf(manifest),
		bootstrapStrategyRef: options.bootstrapStrategyRef,
		claimStrategyRef: `hobo.pack-ownership.${manifest.ownership}/v1`,
		compilerRef: options.compilerRef,
		executorRef: options.executorRef,
		permissionProfileRef: options.permissionProfileRef,
		trustEvidenceRef: options.trustEvidenceRef,
		sourceEvidenceRefs:
			options.sourceEvidenceRefs ??
			manifest.provenance.sourceRefs.map((source) => source.url),
		remediation: options.remediation ?? [],
		providerClass: options.providerClass ?? "verified-emerging",
		evidenceExpiresAtMs: options.evidenceExpiresAtMs,
		evidenceSignatureValid: options.evidenceSignatureValid,
		// Nobody outside the Yard ever held authority over this container.
		creatorAuthorityAfterClaim: "absent" as const,
		claimAtomicity: "single-resource" as const,
		claimActionCount: manifest.ownership === "yard-owned" ? 0 : 1,
		continuity: continuityFor(manifest),
		supportsExport: manifest.operations.some(
			(operation) => operation.kind === "backup",
		),
		supportsRotation: options.supportsRotation ?? true,
		supportsRevocation: options.supportsRevocation ?? true,
		sponsorExposureMinorUnits: 0,
		secretCustodyAvailable: options.secretCustodyAvailable ?? true,
	};
}

export type PackResourceSemantics = ReturnType<typeof toPackResourceSemantics>;

/** Project a verified pack straight into the shape selection consumes. */
export function toPackSelectionCandidate(
	manifest: VerifiedPackManifest,
	options: PackSemanticsOptions,
): SelectionCandidate {
	const semantics = toPackResourceSemantics(manifest, options);
	return {
		definitionId: options.definitionId,
		providerId: options.providerId,
		implementsProfiles: semantics.implementsProfiles,
		runtimeModels: semantics.runtimeModels,
		structuredCapabilities: semantics.structuredCapabilities,
		producesBindingProfiles: semantics.producesBindingProfiles,
		migrationProfiles: semantics.migrationProfiles,
		providerClass: semantics.providerClass,
		evidenceExpiresAtMs: semantics.evidenceExpiresAtMs,
		evidenceSignatureValid: semantics.evidenceSignatureValid,
		creatorAuthorityAfterClaim: semantics.creatorAuthorityAfterClaim,
		claimAtomicity: semantics.claimAtomicity,
		claimActionCount: semantics.claimActionCount,
		continuity: semantics.continuity,
		supportsExport: semantics.supportsExport,
		supportsRotation: semantics.supportsRotation,
		supportsRevocation: semantics.supportsRevocation,
		sponsorExposureMinorUnits: semantics.sponsorExposureMinorUnits,
		hasRegisteredDriver: semantics.executorRef.length > 0,
		secretCustodyAvailable: semantics.secretCustodyAvailable,
	};
}
