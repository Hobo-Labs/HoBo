/**
 * What an operator demands before a provider adapter may be selected.
 *
 * Defaults are fail-closed: anything the operator did not explicitly permit
 * (sponsor spend, bridge realization) is denied, because the cost of a silent
 * default here is paid by whoever inherits the deployment.
 */
import type { ProviderClass } from "@hobo/capability-profiles";

export type CreatorAuthorityRequirement =
	| "must-be-absent"
	| "must-be-rotatable"
	| "may-be-retained";

export type TrustRequirementInput = {
	readonly minimumProviderClass: ProviderClass;
	readonly requireOfficialBootstrapContract: boolean;
	readonly requireDocumentedClaimContract: boolean;
	readonly creatorAuthorityAfterClaim: CreatorAuthorityRequirement;
	readonly maximumClaimActions: number;
	readonly maximumEvidenceAgeMs: number;
	readonly requireStandardBinding?: boolean;
	readonly requireExportProfile?: boolean;
	readonly allowSponsor?: boolean;
	readonly allowPack?: boolean;
	readonly allowBridge?: boolean;
	/** Extra check keys that must be present and `pass`. */
	readonly requiredChecks?: readonly string[];
};

declare const trustRequirementBrand: unique symbol;

// parallel-type-allowed: the branded parse-don't-validate refinement of hobo.trust.v1.TrustRequirement — constructed only by parseTrustRequirement, with every optional dial already resolved to its fail-closed default.
export type TrustRequirement = {
	readonly minimumProviderClass: ProviderClass;
	readonly requireOfficialBootstrapContract: boolean;
	readonly requireDocumentedClaimContract: boolean;
	readonly creatorAuthorityAfterClaim: CreatorAuthorityRequirement;
	readonly maximumClaimActions: number;
	readonly maximumEvidenceAgeMs: number;
	readonly requireStandardBinding: boolean;
	readonly requireExportProfile: boolean;
	readonly allowSponsor: boolean;
	readonly allowPack: boolean;
	readonly allowBridge: boolean;
	readonly requiredChecks: readonly string[];
	readonly [trustRequirementBrand]: "TrustRequirement";
};

export class TrustRequirementError extends Error {
	readonly code = "INVALID_TRUST_REQUIREMENT" as const;

	constructor(message: string) {
		super(message);
		this.name = "TrustRequirementError";
	}
}

const PROVIDER_CLASSES: readonly ProviderClass[] = [
	"established",
	"verified-emerging",
	"experimental",
];

const AUTHORITY_REQUIREMENTS: readonly CreatorAuthorityRequirement[] = [
	"must-be-absent",
	"must-be-rotatable",
	"may-be-retained",
];

export function parseTrustRequirement(
	input: TrustRequirementInput,
): TrustRequirement {
	if (!PROVIDER_CLASSES.includes(input.minimumProviderClass)) {
		throw new TrustRequirementError(
			`unknown provider class ${JSON.stringify(input.minimumProviderClass)}`,
		);
	}
	if (!AUTHORITY_REQUIREMENTS.includes(input.creatorAuthorityAfterClaim)) {
		throw new TrustRequirementError(
			`unknown creator authority requirement ${JSON.stringify(input.creatorAuthorityAfterClaim)}`,
		);
	}
	if (
		!Number.isInteger(input.maximumClaimActions) ||
		input.maximumClaimActions < 0
	) {
		throw new TrustRequirementError(
			"maximumClaimActions must be a non-negative integer",
		);
	}
	if (
		!Number.isInteger(input.maximumEvidenceAgeMs) ||
		input.maximumEvidenceAgeMs <= 0
	) {
		throw new TrustRequirementError(
			"maximumEvidenceAgeMs must be a positive integer",
		);
	}
	const requiredChecks = [...(input.requiredChecks ?? [])];
	for (const key of requiredChecks) {
		if (typeof key !== "string" || key.trim().length === 0) {
			throw new TrustRequirementError(
				"requiredChecks entries must be non-empty strings",
			);
		}
	}

	return {
		minimumProviderClass: input.minimumProviderClass,
		requireOfficialBootstrapContract: input.requireOfficialBootstrapContract,
		requireDocumentedClaimContract: input.requireDocumentedClaimContract,
		creatorAuthorityAfterClaim: input.creatorAuthorityAfterClaim,
		maximumClaimActions: input.maximumClaimActions,
		maximumEvidenceAgeMs: input.maximumEvidenceAgeMs,
		requireStandardBinding: input.requireStandardBinding ?? false,
		requireExportProfile: input.requireExportProfile ?? false,
		allowSponsor: input.allowSponsor ?? false,
		allowPack: input.allowPack ?? true,
		allowBridge: input.allowBridge ?? false,
		requiredChecks: [...new Set(requiredChecks)].sort((a, b) =>
			a.localeCompare(b),
		),
		// The brand is a type-level witness that this value passed the parser.
	} as unknown as TrustRequirement;
}

/** The requirement HoBo applies when an operator states nothing else. */
export const DEFAULT_TRUST_REQUIREMENT: TrustRequirement =
	parseTrustRequirement({
		minimumProviderClass: "verified-emerging",
		requireOfficialBootstrapContract: true,
		requireDocumentedClaimContract: true,
		creatorAuthorityAfterClaim: "must-be-rotatable",
		maximumClaimActions: 2,
		maximumEvidenceAgeMs: 30 * 24 * 60 * 60 * 1000,
	});
