/**
 * Resource Definition vNext — the hosted-product catalog.
 *
 * This deliberately extends the existing {@link ResourceDefinition} rather than
 * introducing a second product registry: Matching, the Planner, and the signed
 * receipt all keep one source of truth. Every new field is optional, so a
 * definition recorded before this schema still parses and still matches through
 * its legacy port/feature path.
 *
 * What a legacy definition does NOT get is promotion. Without declared
 * semantics it never becomes a selection candidate, so it can never be picked
 * as claimable or high-trust by omission.
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
import type { JsonObject, JsonValue } from "../json.js";
import type { ResourceDefinition } from "./catalog.js";

// public-contract: versions the portable resource-definition schema.
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

/** The semantic facts a product must declare to be selectable by profile. */
export type ResourceDefinitionSemantics = {
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
		readonly credentials:
			| "revoked"
			| "rotated"
			| "reauthorized"
			| "retained"
			| "unknown"
			| "not-applicable";
	};
	readonly supportsExport: boolean;
	readonly supportsRotation: boolean;
	readonly supportsRevocation: boolean;
	readonly sponsorExposureMinorUnits: number;
	readonly secretCustodyAvailable: boolean;
};

export type ResourceDefinitionVNext = ResourceDefinition & {
	readonly semantics?: ResourceDefinitionSemantics;
};

export class ResourceDefinitionMigrationError extends Error {
	readonly code = "INVALID_RESOURCE_DEFINITION" as const;
	readonly definitionId: string;

	constructor(definitionId: string, detail: string) {
		super(`resource definition ${definitionId}: ${detail}`);
		this.name = "ResourceDefinitionMigrationError";
		this.definitionId = definitionId;
	}
}

/**
 * Validate the semantic block. Legacy definitions pass straight through with no
 * semantics attached, which is what keeps existing catalogs readable.
 */
export function parseResourceDefinitionVNext(
	definition: ResourceDefinitionVNext,
): ResourceDefinitionVNext {
	const semantics = definition.semantics;
	if (semantics === undefined) return definition;

	if (semantics.schemaVersion !== RESOURCE_DEFINITION_VNEXT_SCHEMA) {
		throw new ResourceDefinitionMigrationError(
			definition.id,
			`unsupported semantics schemaVersion ${String(semantics.schemaVersion)}`,
		);
	}
	if (semantics.implementsProfiles.length === 0) {
		throw new ResourceDefinitionMigrationError(
			definition.id,
			"declares semantics but implements no capability profile",
		);
	}
	if (
		semantics.claimActionCount < 0 ||
		!Number.isInteger(semantics.claimActionCount)
	) {
		throw new ResourceDefinitionMigrationError(
			definition.id,
			"claimActionCount must be a non-negative integer",
		);
	}
	if (semantics.sponsorExposureMinorUnits < 0) {
		throw new ResourceDefinitionMigrationError(
			definition.id,
			"sponsorExposureMinorUnits must not be negative",
		);
	}
	// A driver reference is what separates a described product from a
	// deployable one; selection refuses candidates without it anyway, so
	// catching it at load gives a far better error.
	if (semantics.executorRef.length === 0) {
		throw new ResourceDefinitionMigrationError(
			definition.id,
			"declares semantics but names no executor",
		);
	}
	return definition;
}

/**
 * Project a definition into the shape profile-aware selection consumes.
 *
 * Returns `undefined` for a legacy definition: it stays matchable through the
 * existing port/feature path and is never silently promoted.
 */
export function toSelectionCandidate(
	definition: ResourceDefinitionVNext,
): SelectionCandidate | undefined {
	const semantics = definition.semantics;
	if (semantics === undefined) return undefined;
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

/**
 * Selection-relevant facts folded into the catalog digest.
 *
 * Changing any of these changes the digest and therefore the signed resolution
 * receipt, which is what makes a winner flip attributable to a catalog change.
 */
export function semanticsDigestInput(
	definition: ResourceDefinitionVNext,
): JsonObject | undefined {
	const semantics = definition.semantics;
	if (semantics === undefined) return undefined;
	return {
		id: definition.id,
		productId: semantics.productId,
		implementsProfiles: [...semantics.implementsProfiles]
			.map((implementation) => ({
				profileId: implementation.profileId,
				versionRange: implementation.versionRange,
				realization: implementation.realization,
				conformanceRef: implementation.conformanceRef,
				conformance: implementation.conformance,
			}))
			.sort((a, b) => a.profileId.localeCompare(b.profileId)),
		runtimeModels: [...semantics.runtimeModels].sort(),
		producesBindingProfiles: [...semantics.producesBindingProfiles].sort(),
		migrationProfiles: [...semantics.migrationProfiles].sort(),
		bootstrapStrategyRef: semantics.bootstrapStrategyRef,
		claimStrategyRef: semantics.claimStrategyRef,
		compilerRef: semantics.compilerRef,
		executorRef: semantics.executorRef,
		trustEvidenceRef: semantics.trustEvidenceRef,
		providerClass: semantics.providerClass,
		evidenceExpiresAtMs: semantics.evidenceExpiresAtMs ?? null,
		evidenceSignatureValid: semantics.evidenceSignatureValid,
		creatorAuthorityAfterClaim: semantics.creatorAuthorityAfterClaim,
		claimAtomicity: semantics.claimAtomicity,
		claimActionCount: semantics.claimActionCount,
		continuity: semantics.continuity,
		supportsExport: semantics.supportsExport,
		sponsorExposureMinorUnits: semantics.sponsorExposureMinorUnits,
		// Array values are readonly on the semantics record and mutable in the
		// JSON view; copying is what publishing means here anyway -- this is a
		// snapshot, not a live window onto the definition it came from.
		structuredCapabilities: Object.fromEntries(
			Object.entries(semantics.structuredCapabilities)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, value]): [string, JsonValue] => [
					key,
					typeof value === "object" ? [...value] : value,
				]),
		),
	};
}
