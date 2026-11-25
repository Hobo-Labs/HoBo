/**
 * The request manifest: one catalog offer, as selection sees it.
 *
 * `SelectionCandidate` is the minimal structural view the capability selector
 * gates and ranks — a projection of a Resource Definition rather than the
 * definition itself, so a provider package widens what it already has instead
 * of maintaining a second catalog.
 *
 * Three rules here are the whole point of the package:
 *
 *  - **Parse, don't validate.** `parseSelectionCandidate` takes `unknown` and
 *    returns a branded {@link ParsedSelectionCandidate}, or throws
 *    {@link SelectionCandidateError} naming the field. Nothing downstream
 *    re-checks a value that got past it.
 *  - **Absent is not undefined and is not null.** `evidenceExpiresAtMs` is
 *    optional; absence means "no trust evidence recorded", which fails the
 *    evidence gate closed. An explicit `null` is refused rather than coerced,
 *    because a producer that emits null has made a claim ("this field is
 *    known to be empty") the gate would then silently reinterpret.
 *  - **Canonical form is a set of decisions, not a formatting preference.**
 *    Set-valued fields sort by code point and reject duplicates; the ordered
 *    field (`implementsProfiles`) keeps its order. Two catalogs holding the
 *    same facts therefore encode to the same bytes, which is the only thing
 *    that makes a digest over a candidate comparable across packages.
 *
 * ## Parse, don't validate — the derived types
 *
 * {@link parseSelectionCandidate} is the only way to obtain a
 * {@link ParsedSelectionCandidate}: the branded parsed derived type that says
 * "these bytes were checked". Downstream code holding one never re-checks it.
 * {@link SelectionCandidate} stays structural and unbranded because every
 * provider package authors one as an object literal, and a brand on that type
 * would make those literals unassignable — so the derived type is a refinement
 * of the authoring type rather than a replacement for it.
 * {@link SelectionCandidateRecord} is the third: the wire derived type, in
 * canonical form by construction because {@link toSelectionCandidateRecord}
 * parses before it encodes.
 *
 * ## Where this sits in the control plane
 *
 * A candidate is catalog data carried in the body of a *command*, never the
 * body of an event. A `hobo plan` command hands the Planner actor a catalog
 * snapshot of these rows; the actor selects over them and appends the
 * resulting `match.Decided` and `deployment.Planned` events to the
 * event store. The deployment projection and the plan read store are
 * materialized views folded from those events, and a snapshot of the
 * projection is what a later reader loads instead of replaying the stream. What binds this package
 * to any of it is the digest: `profileCatalogHash` folds the catalog into the
 * signed resolution receipt, which is why the canonical bytes here are a
 * contract rather than a formatting choice. Nothing in this package writes to
 * a stream, owns an actor, or holds state — a manifest package owns a shape
 * and its parse boundary, and nothing else.
 */
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

/** Wire identity of this manifest. Bumped only by a breaking field change. */
// public-contract: the schema version consumers pin a candidate record to.
export const SELECTION_CANDIDATE_SCHEMA_VERSION =
	"hobo.selection-candidate/v1" as const;

/** Every refusal this module raises. The `path` names the offending field. */
export class SelectionCandidateError extends Error {
	readonly code = "INVALID_SELECTION_CANDIDATE" as const;
	readonly path: string;

	constructor(path: string, detail: string) {
		super(`invalid selection candidate at ${path}: ${detail}`);
		this.name = "SelectionCandidateError";
		this.path = path;
	}
}

/** A structured capability value. Objects are deliberately not admissible. */
export type StructuredCapabilityValue =
	| boolean
	| number
	| string
	| readonly string[];

/** A profile implementation claim made by a hosted product or pack. */
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

/**
 * The minimal structural view selection needs.
 *
 * Structural, not branded: `@hobo/cloud` and every provider package build one
 * as an object literal, and a brand here would make those literals
 * unassignable. {@link parseSelectionCandidate} returns the branded refinement
 * instead, so "this was checked" is expressible without breaking authoring.
 */
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
	/** Evidence expiry as epoch milliseconds. Absent means no live evidence. */
	readonly evidenceExpiresAtMs?: number;
	readonly evidenceSignatureValid: boolean;
	readonly creatorAuthorityAfterClaim: CreatorAuthorityAfterClaim;
	readonly claimAtomicity: ClaimAtomicity;
	readonly claimActionCount: number;
	readonly continuity: CandidateContinuity;
	readonly supportsExport: boolean;
	readonly supportsRotation: boolean;
	readonly supportsRevocation: boolean;
	/** Sponsor exposure in minor currency units. 0 for user-owned/anonymous. */
	readonly sponsorExposureMinorUnits: number;
	readonly hasRegisteredDriver: boolean;
	readonly secretCustodyAvailable: boolean;
};

declare const selectionCandidateBrand: unique symbol;

/** A candidate that has been through {@link parseSelectionCandidate}. */
export type ParsedSelectionCandidate = SelectionCandidate & {
	readonly [selectionCandidateBrand]: typeof SELECTION_CANDIDATE_SCHEMA_VERSION;
};

/** The wire record: snake_case, canonically ordered, digest-ready. */
// parallel-type-allowed: hand-declared wire form of ProfileImplementationRecord in data-models/selection_candidate.proto; this package has no data-models/buf.yaml, so codegen produces no src/_generated/*_pb.ts to import — replace with the generated type when manifest packages opt into codegen.
export type ProfileImplementationRecord = {
	readonly profile_id: string;
	readonly version_range: string;
	readonly realization: RealizationKind;
	readonly conformance_ref: string;
	readonly conformance: ConformanceResult;
};

// parallel-type-allowed: hand-declared wire form of CandidateContinuityRecord; its two continuity vocabularies are distinct closed enums that a generated type would spell as plain strings, so the generated form is a widening until the CUE constraint set is enforced in codegen.
export type CandidateContinuityRecord = {
	readonly endpoint: ContinuityGrade;
	readonly data: ContinuityGrade;
	readonly credentials: CredentialContinuity;
};

// parallel-type-allowed: hand-declared wire form of SelectionCandidateRecord; the declaration order of its fields IS the canonical JSON key order a digest is taken over, which is a property this package must state rather than inherit from a generator it does not yet run.
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

/** Same profile-id syntax `@hobo/capability-profiles` pins. */
const PROFILE_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*\/v[0-9]+$/u;
const VERSION_RANGE_PATTERN =
	/^(?:\*|[><]=?|=|\^|~)?\s*v?[0-9]+(?:\.[0-9]+){0,2}$/u;
/**
 * Capability keys must not be array-index-shaped.
 *
 * JavaScript reorders integer-like own keys to the front of an object, so a
 * key of `"0"` would move ahead of the sorted keys in the canonical JSON and
 * quietly break byte-identity between two catalogs holding the same facts.
 * Requiring a leading letter is what makes the sort observable on the wire.
 */
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

/** Code-point order, never the host's collation locale. */
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

/** A set-valued field: no duplicates, canonically sorted by code point. */
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
		// -0 serializes as `0`, so keeping it would make the round trip lossy in
		// the domain object while looking byte-identical on the wire.
		return Object.is(value, -0) ? 0 : value;
	}
	if (Array.isArray(value)) {
		// A list value keeps its order: it is a value, not a set, and every
		// operator that reads one (`one-of`, `includes-all`) is order-blind
		// anyway, so reordering would lose information for no gain.
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

/**
 * Ordered, and never two claims for the same profile.
 *
 * Order is preserved because selection takes the first entry that satisfies a
 * required profile, so the list position decides which realization is chosen.
 * Two claims for one profile are refused for the same reason: the choice
 * between them would rest on position alone, with nothing to appeal to.
 */
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

/**
 * Absent, `null` and `undefined` are three different claims, and only the
 * first is admissible.
 *
 * `exactOptionalPropertyTypes` draws exactly this line in the type system: an
 * optional field and a field that may hold `undefined` are not the same field.
 * A producer that sets the key to `null` or `undefined` has asserted something
 * about the value; omitting the key asserts that no evidence was recorded, and
 * only that spelling reaches the evidence gate as a fail-closed fact.
 */
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

/**
 * Parse-don't-validate boundary for a catalog offer.
 *
 * Unknown fields are refused rather than dropped: a producer that carries a
 * selection-relevant fact this schema does not model would otherwise have it
 * silently deleted from every digest taken downstream.
 */
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

/**
 * Encode to the canonical wire record.
 *
 * Parses first, so the output is canonical whatever the input's array order
 * or key order was. Key insertion order here IS the wire order — the record
 * is what a digest is taken over.
 */
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

/** Decode a wire record. Refuses an unrecognized schema version outright. */
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

/**
 * The bytes a digest is taken over.
 *
 * Digesting itself is the caller's: `@hobo/cloud` folds a candidate into a
 * catalog digest and `@hobo/recipes` into an offer digest, with different
 * surrounding payloads. What they must agree on is this string.
 */
export function canonicalSelectionCandidateJson(
	candidate: SelectionCandidate,
): string {
	return JSON.stringify(toSelectionCandidateRecord(candidate));
}
