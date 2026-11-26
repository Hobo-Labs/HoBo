/**
 * The vNext semantics block, declared locally on purpose.
 *
 * `@hobo/cloud` owns the catalog and already consumes provider packages, so a
 * provider package must not depend on it — that edge would close a cycle. This
 * type mirrors `ResourceDefinitionSemantics` from
 * `packages/cloud/src/registry/resource-definition-vnext.ts` field for field, so
 * the catalog can register these blocks as `ResourceDefinitionVNext.semantics`
 * without translation. Registration itself is a catalog-side change.
 */
import type {
	BindleRuntime,
	ClaimAtomicity,
	ContinuityGrade,
	CreatorAuthorityAfterClaim,
	ProfileImplementation,
	ProviderClass,
	SelectionCandidate,
} from "@hobo/capability-profiles";

// public-contract: schema identity shared with Resource Definition consumers.
export const RESOURCE_DEFINITION_VNEXT_SCHEMA =
	"hobo.resource-definition/vNext" as const;

export type PlacementConstraint = {
	readonly key: string;
	readonly operator: "in" | "not-in" | "equals" | "exists";
	readonly values: readonly string[];
};

export type RemediationHint = {
	readonly code: string;
	readonly message: string;
};

export type CredentialContinuityGrade =
	| "revoked"
	| "rotated"
	| "reauthorized"
	| "retained"
	| "unknown"
	| "not-applicable";

export type ResourceDefinitionSemanticsData = {
	readonly schemaVersion: typeof RESOURCE_DEFINITION_VNEXT_SCHEMA;
	readonly productId: string;
	readonly displayName: string;
	readonly implementsProfiles: readonly ProfileImplementation[];
	readonly runtimeModels: readonly BindleRuntime[];
	readonly structuredCapabilities: Readonly<
		Record<string, boolean | number | string | readonly string[]>
	>;
	readonly placementConstraints: readonly PlacementConstraint[];
	readonly producesBindingProfiles: readonly string[];
	readonly requiresConnectivityProfiles?: readonly string[];
	readonly migrationProfiles: readonly string[];
	readonly bootstrapStrategyRef: string;
	readonly guestLeaseTemplateRef?: string;
	readonly claimStrategyRef: string;
	readonly compilerRef: string;
	readonly executorRef: string;
	readonly permissionProfileRef: string;
	readonly trustEvidenceRef: string;
	readonly sourceEvidenceRefs: readonly string[];
	readonly remediation: readonly RemediationHint[];
	readonly providerClass: ProviderClass;
	readonly evidenceExpiresAtMs?: number;
	readonly evidenceSignatureValid: boolean;
	readonly creatorAuthorityAfterClaim: CreatorAuthorityAfterClaim;
	readonly claimAtomicity: ClaimAtomicity;
	readonly claimActionCount: number;
	readonly continuity: {
		readonly endpoint: ContinuityGrade;
		readonly data: ContinuityGrade;
		readonly credentials: CredentialContinuityGrade;
	};
	readonly supportsExport: boolean;
	readonly supportsRotation: boolean;
	readonly supportsRevocation: boolean;
	readonly sponsorExposureMinorUnits: number;
	readonly secretCustodyAvailable: boolean;
};

/** A definition record shaped for catalog registration. Data only. */
export type ProviderResourceDefinitionData = {
	readonly id: string;
	readonly providerId: string;
	readonly port: string;
	readonly semantics: ResourceDefinitionSemanticsData;
};

/**
 * The same projection `@hobo/cloud` performs, kept here so a provider package
 * can be selected against without the catalog in the loop (tests do exactly
 * that). `hasRegisteredDriver` follows the executor reference, as it does in
 * the catalog.
 */
export function semanticsToSelectionCandidate(
	definition: ProviderResourceDefinitionData,
): SelectionCandidate {
	const semantics = definition.semantics;
	return {
		definitionId: definition.id,
		providerId: definition.providerId,
		implementsProfiles: semantics.implementsProfiles,
		runtimeModels: semantics.runtimeModels,
		structuredCapabilities: semantics.structuredCapabilities,
		producesBindingProfiles: semantics.producesBindingProfiles,
		migrationProfiles: semantics.migrationProfiles,
		providerClass: semantics.providerClass,
		...(semantics.evidenceExpiresAtMs !== undefined
			? { evidenceExpiresAtMs: semantics.evidenceExpiresAtMs }
			: undefined),
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

export type ProviderSourceRef = {
	readonly url: string;
	readonly checkedAt: string;
	readonly note: string;
};
