import {
	BINDLE_RUNTIMES,
	type BindleRuntime,
	CLAIM_ATOMICITIES,
	type ClaimAtomicity,
	CONFORMANCE_RESULTS,
	CONTINUITY_GRADES,
	type ConformanceResult,
	type ContinuityGrade,
	CREATOR_AUTHORITIES_AFTER_CLAIM,
	CREDENTIAL_CONTINUITY_GRADES,
	type CreatorAuthorityAfterClaim,
	type CredentialContinuity,
	PROVIDER_CLASSES,
	type ProviderClass,
	REALIZATION_KINDS,
	type RealizationKind,
} from "./vocabulary.js";

export const SELECTION_CANDIDATE_SCHEMA_VERSION =
	"hobo.selection-candidate/v1" as const;

export class SelectionCandidateError extends Error {
	readonly code = "INVALID_SELECTION_CANDIDATE" as const;
	readonly path: string;

	constructor(path: string, detail: string) {
		super(`invalid selection candidate at ${path}: ${detail}`);
		this.name = "SelectionCandidateError";
		this.path = path;
	}
}

export type StructuredCapabilityValue =
	| boolean
	| number
	| string
	| readonly string[];

export type ProfileImplementation = {
	readonly profileId: string;
	readonly versionRange: string;
	readonly realization: RealizationKind;
	readonly conformanceRef: string;
	readonly conformance: ConformanceResult;
};

export type CandidateContinuity = {
	readonly endpoint: ContinuityGrade;
	readonly data: ContinuityGrade;
	readonly credentials: CredentialContinuity;
};

export type SelectionCandidate = {
	readonly definitionId: string;
	readonly providerId: string;
	readonly implementsProfiles: readonly ProfileImplementation[];
	readonly runtimeModels: readonly BindleRuntime[];
	readonly structuredCapabilities: Readonly<
		Record<string, StructuredCapabilityValue>
	>;
	readonly producesBindingProfiles: readonly string[];
	readonly migrationProfiles: readonly string[];
	readonly providerClass: ProviderClass;
	readonly evidenceExpiresAtMs?: number;
	readonly evidenceSignatureValid: boolean;
	readonly creatorAuthorityAfterClaim: CreatorAuthorityAfterClaim;
	readonly claimAtomicity: ClaimAtomicity;
	readonly claimActionCount: number;
	readonly continuity: CandidateContinuity;
	readonly supportsExport: boolean;
	readonly supportsRotation: boolean;
	readonly supportsRevocation: boolean;
	readonly sponsorExposureMinorUnits: number;
	readonly hasRegisteredDriver: boolean;
	readonly secretCustodyAvailable: boolean;
};

declare const selectionCandidateBrand: unique symbol;

export type ParsedSelectionCandidate = SelectionCandidate & {
	readonly [selectionCandidateBrand]: typeof SELECTION_CANDIDATE_SCHEMA_VERSION;
};

export type ProfileImplementationRecord = {
	readonly profile_id: string;
	readonly version_range: string;
	readonly realization: RealizationKind;
	readonly conformance_ref: string;
	readonly conformance: ConformanceResult;
};

export type CandidateContinuityRecord = {
	readonly endpoint: ContinuityGrade;
	readonly data: ContinuityGrade;
	readonly credentials: CredentialContinuity;
};

export type SelectionCandidateRecord = {
	readonly schema_version: typeof SELECTION_CANDIDATE_SCHEMA_VERSION;
	readonly definition_id: string;
	readonly provider_id: string;
	readonly implements_profiles: readonly ProfileImplementationRecord[];
	readonly runtime_models: readonly BindleRuntime[];
	readonly structured_capabilities: Readonly<
		Record<string, StructuredCapabilityValue>
	>;
	readonly produces_binding_profiles: readonly string[];
	readonly migration_profiles: readonly string[];
	readonly provider_class: ProviderClass;
	readonly evidence_expires_at_ms?: number;
	readonly evidence_signature_valid: boolean;
	readonly creator_authority_after_claim: CreatorAuthorityAfterClaim;
	readonly claim_atomicity: ClaimAtomicity;
	readonly claim_action_count: number;
	readonly continuity: CandidateContinuityRecord;
	readonly supports_export: boolean;
	readonly supports_rotation: boolean;
	readonly supports_revocation: boolean;
	readonly sponsor_exposure_minor_units: number;
	readonly has_registered_driver: boolean;
	readonly secret_custody_available: boolean;
};

const PROFILE_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*\/v[0-9]+$/u;
const VERSION_RANGE_PATTERN =
	/^(?:\*|[><]=?|=|\^|~)?\s*v?[0-9]+(?:\.[0-9]+){0,2}$/u;
const CAPABILITY_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/u;

const CANDIDATE_FIELDS = [
	"definitionId",
	"providerId",
	"implementsProfiles",
	"runtimeModels",
	"structuredCapabilities",
	"producesBindingProfiles",
	"migrationProfiles",
	"providerClass",
	"evidenceExpiresAtMs",
	"evidenceSignatureValid",
	"creatorAuthorityAfterClaim",
	"claimAtomicity",
	"claimActionCount",
	"continuity",
	"supportsExport",
	"supportsRotation",
	"supportsRevocation",
	"sponsorExposureMinorUnits",
	"hasRegisteredDriver",
	"secretCustodyAvailable",
] as const;

const IMPLEMENTATION_FIELDS = [
	"profileId",
	"versionRange",
	"realization",
	"conformanceRef",
	"conformance",
] as const;

const CONTINUITY_FIELDS = ["endpoint", "data", "credentials"] as const;

const RECORD_FIELDS = [
	"schema_version",
	"definition_id",
	"provider_id",
	"implements_profiles",
	"runtime_models",
	"structured_capabilities",
	"produces_binding_profiles",
	"migration_profiles",
	"provider_class",
	"evidence_expires_at_ms",
	"evidence_signature_valid",
	"creator_authority_after_claim",
	"claim_atomicity",
	"claim_action_count",
	"continuity",
	"supports_export",
	"supports_rotation",
	"supports_revocation",
	"sponsor_exposure_minor_units",
	"has_registered_driver",
	"secret_custody_available",
] as const;

function compareCodePoints(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function asObject(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new SelectionCandidateError(
			path,
			`must be an object, got ${describe(value)}`,
		);
	}
	return value as Record<string, unknown>;
}

function describe(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	return typeof value;
}

function rejectUnknownKeys(
	source: Record<string, unknown>,
	known: readonly string[],
	path: string,
): void {
	const unknownKeys = Object.keys(source)
		.filter((key) => !known.includes(key))
		.sort(compareCodePoints);
	if (unknownKeys.length > 0) {
		throw new SelectionCandidateError(
			path,
			`unknown field(s) ${unknownKeys.map((key) => JSON.stringify(key)).join(", ")}; a fact selection cannot read is a fact no digest covers`,
		);
	}
}

function asNonEmptyString(value: unknown, path: string): string {
	if (typeof value !== "string") {
		throw new SelectionCandidateError(
			path,
			`must be a string, got ${describe(value)}`,
		);
	}
	if (value.length === 0) {
		throw new SelectionCandidateError(path, "must not be empty");
	}
	return value;
}

function asBoolean(value: unknown, path: string): boolean {
	if (typeof value !== "boolean") {
		throw new SelectionCandidateError(
			path,
			`must be a boolean, got ${describe(value)}`,
		);
	}
	return value;
}

function asNonNegativeInteger(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) {
		throw new SelectionCandidateError(
			path,
			`must be a safe integer, got ${describe(value)}`,
		);
	}
	if (value < 0) {
		throw new SelectionCandidateError(
			path,
			`must not be negative, got ${value}`,
		);
	}
	return value;
}

function asMember<T extends string>(
	value: unknown,
	allowed: readonly T[],
	path: string,
): T {
	if (
		typeof value !== "string" ||
		!(allowed as readonly string[]).includes(value)
	) {
		throw new SelectionCandidateError(
			path,
			`must be one of ${allowed.map((entry) => JSON.stringify(entry)).join(", ")}, got ${JSON.stringify(value)}`,
		);
	}
	return value as T;
}

function asArray(value: unknown, path: string): readonly unknown[] {
	if (!Array.isArray(value)) {
		throw new SelectionCandidateError(
			path,
			`must be an array, got ${describe(value)}`,
		);
	}
	return value;
}

function assertNoDuplicates(values: readonly string[], path: string): void {
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) {
			throw new SelectionCandidateError(
				path,
				`must not repeat ${JSON.stringify(value)}`,
			);
		}
		seen.add(value);
	}
}

function parseStringSet(value: unknown, path: string): readonly string[] {
	const entries = asArray(value, path).map((entry, index) =>
		asNonEmptyString(entry, `${path}[${index}]`),
	);
	assertNoDuplicates(entries, path);
	return [...entries].sort(compareCodePoints);
}

function parseRuntimeModels(
	value: unknown,
	path: string,
): readonly BindleRuntime[] {
	const entries = asArray(value, path).map((entry, index) =>
		asMember(entry, BINDLE_RUNTIMES, `${path}[${index}]`),
	);
	assertNoDuplicates(entries, path);
	return [...entries].sort(compareCodePoints);
}

function parseCapabilityValue(
	value: unknown,
	path: string,
): StructuredCapabilityValue {
	if (typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new SelectionCandidateError(
				path,
				`must be a finite number, got ${String(value)}`,
			);
		}
		return Object.is(value, -0) ? 0 : value;
	}
	if (Array.isArray(value)) {
		return value.map((entry, index) =>
			asNonEmptyString(entry, `${path}[${index}]`),
		);
	}
	throw new SelectionCandidateError(
		path,
		`must be a boolean, finite number, string, or string array, got ${describe(value)}`,
	);
}

function parseStructuredCapabilities(
	value: unknown,
	path: string,
): Readonly<Record<string, StructuredCapabilityValue>> {
	const source = asObject(value, path);
	const keys = Object.keys(source).sort(compareCodePoints);
	for (const key of keys) {
		if (!CAPABILITY_KEY_PATTERN.test(key)) {
			throw new SelectionCandidateError(
				`${path}.${key}`,
				`key must match ${CAPABILITY_KEY_PATTERN.source}`,
			);
		}
	}
	return Object.fromEntries(
		keys.map((key) => [
			key,
			parseCapabilityValue(source[key], `${path}.${key}`),
		]),
	);
}

function parseImplementation(
	value: unknown,
	path: string,
): ProfileImplementation {
	const source = asObject(value, path);
	rejectUnknownKeys(source, IMPLEMENTATION_FIELDS, path);
	const profileId = asNonEmptyString(source.profileId, `${path}.profileId`);
	if (!PROFILE_ID_PATTERN.test(profileId)) {
		throw new SelectionCandidateError(
			`${path}.profileId`,
			`must match ${PROFILE_ID_PATTERN.source}, got ${JSON.stringify(profileId)}`,
		);
	}
	const versionRange = asNonEmptyString(
		source.versionRange,
		`${path}.versionRange`,
	);
	if (!VERSION_RANGE_PATTERN.test(versionRange)) {
		throw new SelectionCandidateError(
			`${path}.versionRange`,
			`must match ${VERSION_RANGE_PATTERN.source}, got ${JSON.stringify(versionRange)}`,
		);
	}
	return {
		profileId,
		versionRange,
		realization: asMember(
			source.realization,
			REALIZATION_KINDS,
			`${path}.realization`,
		),
		conformanceRef: asNonEmptyString(
			source.conformanceRef,
			`${path}.conformanceRef`,
		),
		conformance: asMember(
			source.conformance,
			CONFORMANCE_RESULTS,
			`${path}.conformance`,
		),
	};
}

function parseImplementations(
	value: unknown,
	path: string,
): readonly ProfileImplementation[] {
	const entries = asArray(value, path).map((entry, index) =>
		parseImplementation(entry, `${path}[${index}]`),
	);
	assertNoDuplicates(
		entries.map((entry) => entry.profileId),
		path,
	);
	return entries;
}

function parseContinuity(value: unknown, path: string): CandidateContinuity {
	const source = asObject(value, path);
	rejectUnknownKeys(source, CONTINUITY_FIELDS, path);
	return {
		endpoint: asMember(source.endpoint, CONTINUITY_GRADES, `${path}.endpoint`),
		data: asMember(source.data, CONTINUITY_GRADES, `${path}.data`),
		credentials: asMember(
			source.credentials,
			CREDENTIAL_CONTINUITY_GRADES,
			`${path}.credentials`,
		),
	};
}

function parseEvidenceExpiry(value: unknown, path: string): number {
	if (value === null) {
		throw new SelectionCandidateError(
			path,
			"must be absent rather than null; absence is the 'no live evidence' fact and null is a second spelling of it",
		);
	}
	if (value === undefined) {
		throw new SelectionCandidateError(
			path,
			"must be absent rather than present-and-undefined; an optional field and a field holding undefined are different facts",
		);
	}
	if (typeof value !== "number" || !Number.isSafeInteger(value)) {
		throw new SelectionCandidateError(
			path,
			`must be epoch milliseconds as a safe integer, got ${describe(value)}`,
		);
	}
	return value;
}

export function parseSelectionCandidate(
	input: unknown,
): ParsedSelectionCandidate {
	const source = asObject(input, "selectionCandidate");
	rejectUnknownKeys(source, CANDIDATE_FIELDS, "selectionCandidate");
	const candidate: SelectionCandidate = {
		definitionId: asNonEmptyString(source.definitionId, "definitionId"),
		providerId: asNonEmptyString(source.providerId, "providerId"),
		implementsProfiles: parseImplementations(
			source.implementsProfiles,
			"implementsProfiles",
		),
		runtimeModels: parseRuntimeModels(source.runtimeModels, "runtimeModels"),
		structuredCapabilities: parseStructuredCapabilities(
			source.structuredCapabilities,
			"structuredCapabilities",
		),
		producesBindingProfiles: parseStringSet(
			source.producesBindingProfiles,
			"producesBindingProfiles",
		),
		migrationProfiles: parseStringSet(
			source.migrationProfiles,
			"migrationProfiles",
		),
		providerClass: asMember(
			source.providerClass,
			PROVIDER_CLASSES,
			"providerClass",
		),
		...(Object.hasOwn(source, "evidenceExpiresAtMs")
			? {
					evidenceExpiresAtMs: parseEvidenceExpiry(
						source.evidenceExpiresAtMs,
						"evidenceExpiresAtMs",
					),
				}
			: {}),
		evidenceSignatureValid: asBoolean(
			source.evidenceSignatureValid,
			"evidenceSignatureValid",
		),
		creatorAuthorityAfterClaim: asMember(
			source.creatorAuthorityAfterClaim,
			CREATOR_AUTHORITIES_AFTER_CLAIM,
			"creatorAuthorityAfterClaim",
		),
		claimAtomicity: asMember(
			source.claimAtomicity,
			CLAIM_ATOMICITIES,
			"claimAtomicity",
		),
		claimActionCount: asNonNegativeInteger(
			source.claimActionCount,
			"claimActionCount",
		),
		continuity: parseContinuity(source.continuity, "continuity"),
		supportsExport: asBoolean(source.supportsExport, "supportsExport"),
		supportsRotation: asBoolean(source.supportsRotation, "supportsRotation"),
		supportsRevocation: asBoolean(
			source.supportsRevocation,
			"supportsRevocation",
		),
		sponsorExposureMinorUnits: asNonNegativeInteger(
			source.sponsorExposureMinorUnits,
			"sponsorExposureMinorUnits",
		),
		hasRegisteredDriver: asBoolean(
			source.hasRegisteredDriver,
			"hasRegisteredDriver",
		),
		secretCustodyAvailable: asBoolean(
			source.secretCustodyAvailable,
			"secretCustodyAvailable",
		),
	};
	return candidate as ParsedSelectionCandidate;
}

export function toSelectionCandidateRecord(
	candidate: SelectionCandidate,
): SelectionCandidateRecord {
	const parsed = parseSelectionCandidate(candidate);
	return {
		schema_version: SELECTION_CANDIDATE_SCHEMA_VERSION,
		definition_id: parsed.definitionId,
		provider_id: parsed.providerId,
		implements_profiles: parsed.implementsProfiles.map((implementation) => ({
			profile_id: implementation.profileId,
			version_range: implementation.versionRange,
			realization: implementation.realization,
			conformance_ref: implementation.conformanceRef,
			conformance: implementation.conformance,
		})),
		runtime_models: parsed.runtimeModels,
		structured_capabilities: parsed.structuredCapabilities,
		produces_binding_profiles: parsed.producesBindingProfiles,
		migration_profiles: parsed.migrationProfiles,
		provider_class: parsed.providerClass,
		...(parsed.evidenceExpiresAtMs === undefined
			? {}
			: { evidence_expires_at_ms: parsed.evidenceExpiresAtMs }),
		evidence_signature_valid: parsed.evidenceSignatureValid,
		creator_authority_after_claim: parsed.creatorAuthorityAfterClaim,
		claim_atomicity: parsed.claimAtomicity,
		claim_action_count: parsed.claimActionCount,
		continuity: {
			endpoint: parsed.continuity.endpoint,
			data: parsed.continuity.data,
			credentials: parsed.continuity.credentials,
		},
		supports_export: parsed.supportsExport,
		supports_rotation: parsed.supportsRotation,
		supports_revocation: parsed.supportsRevocation,
		sponsor_exposure_minor_units: parsed.sponsorExposureMinorUnits,
		has_registered_driver: parsed.hasRegisteredDriver,
		secret_custody_available: parsed.secretCustodyAvailable,
	};
}

export function fromSelectionCandidateRecord(
	input: unknown,
): ParsedSelectionCandidate {
	const source = asObject(input, "selectionCandidateRecord");
	rejectUnknownKeys(source, RECORD_FIELDS, "selectionCandidateRecord");
	if (source.schema_version !== SELECTION_CANDIDATE_SCHEMA_VERSION) {
		throw new SelectionCandidateError(
			"selectionCandidateRecord.schema_version",
			`must be ${JSON.stringify(SELECTION_CANDIDATE_SCHEMA_VERSION)}, got ${JSON.stringify(source.schema_version)}`,
		);
	}
	const implementations = asArray(
		source.implements_profiles,
		"selectionCandidateRecord.implements_profiles",
	).map((entry, index) => {
		const claim = asObject(
			entry,
			`selectionCandidateRecord.implements_profiles[${index}]`,
		);
		return {
			profileId: claim.profile_id,
			versionRange: claim.version_range,
			realization: claim.realization,
			conformanceRef: claim.conformance_ref,
			conformance: claim.conformance,
		};
	});
	const continuity = asObject(
		source.continuity,
		"selectionCandidateRecord.continuity",
	);
	return parseSelectionCandidate({
		definitionId: source.definition_id,
		providerId: source.provider_id,
		implementsProfiles: implementations,
		runtimeModels: source.runtime_models,
		structuredCapabilities: source.structured_capabilities,
		producesBindingProfiles: source.produces_binding_profiles,
		migrationProfiles: source.migration_profiles,
		providerClass: source.provider_class,
		...(Object.hasOwn(source, "evidence_expires_at_ms")
			? { evidenceExpiresAtMs: source.evidence_expires_at_ms }
			: {}),
		evidenceSignatureValid: source.evidence_signature_valid,
		creatorAuthorityAfterClaim: source.creator_authority_after_claim,
		claimAtomicity: source.claim_atomicity,
		claimActionCount: source.claim_action_count,
		continuity: {
			endpoint: continuity.endpoint,
			data: continuity.data,
			credentials: continuity.credentials,
		},
		supportsExport: source.supports_export,
		supportsRotation: source.supports_rotation,
		supportsRevocation: source.supports_revocation,
		sponsorExposureMinorUnits: source.sponsor_exposure_minor_units,
		hasRegisteredDriver: source.has_registered_driver,
		secretCustodyAvailable: source.secret_custody_available,
	});
}

export function canonicalSelectionCandidateJson(
	candidate: SelectionCandidate,
): string {
	return JSON.stringify(toSelectionCandidateRecord(candidate));
}
