/**
 * The read boundary for a matrix that came from somewhere else.
 *
 * A matrix that has been committed to a repository, shipped over a wire, or
 * round-tripped through JSON is untrusted input. This is the one place it
 * crosses back into a derived domain type: past `parseCapabilityMatrix` an
 * incomplete grid, an unknown verdict, an unsorted bucket, or a digest that
 * does not describe the body is unrepresentable, so no consumer re-checks
 * them.
 *
 * Parse, don't validate — the return type is the proof, not a boolean.
 */
import {
	isBindlePrimitive,
	isBindleRuntime,
	REALIZATION_KINDS,
} from "@hobo/capability-profiles";
import { DIGEST_PATTERN } from "@hobo/trust";

import {
	CANDIDATE_BUCKETS,
	CANDIDATE_UNAVAILABILITY_CODES,
	type CandidateBucket,
	type CandidateUnavailability,
	type CapabilityMatrixCandidate,
} from "./candidate.js";
import { capabilityMatrixDigest } from "./digest.js";
import {
	CAPABILITY_MATRIX_COORDINATES,
	type CapabilityMatrixCoordinate,
} from "./grid.js";
import {
	CAPABILITY_MATRIX_SCHEMA_VERSION,
	type CapabilityMatrix,
	type CapabilityMatrixBucket,
	type CapabilityMatrixBuckets,
	type CapabilityMatrixCell,
	type CapabilityMatrixExclusion,
	COVERAGE_VERDICTS,
	type CoverageVerdict,
	deriveCoverageVerdict,
	MATRIX_EXCLUSION_CODES,
} from "./matrix.js";

export const CAPABILITY_MATRIX_ERROR_CODES = [
	"INVALID_CAPABILITY_MATRIX",
	"INCOMPLETE_GRID",
	"UNKNOWN_VOCABULARY",
	"DIGEST_MISMATCH",
] as const;

export type CapabilityMatrixErrorCode =
	(typeof CAPABILITY_MATRIX_ERROR_CODES)[number];

export class CapabilityMatrixError extends Error {
	readonly code: CapabilityMatrixErrorCode;
	readonly path: string;

	constructor(code: CapabilityMatrixErrorCode, path: string, detail: string) {
		super(`${path}: ${detail}`);
		this.name = "CapabilityMatrixError";
		this.code = code;
		this.path = path;
	}
}

const tagOf = Object.prototype.toString;

type JsonObject = { [key: string]: JsonValue };
type JsonValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| JsonValue[]
	| JsonObject;
export type CapabilityMatrixDocument = JsonValue;

function object(value: JsonValue, path: string): JsonObject {
	if (
		value === null ||
		Array.isArray(value) ||
		tagOf.call(value) !== "[object Object]"
	) {
		throw new CapabilityMatrixError(
			"INVALID_CAPABILITY_MATRIX",
			path,
			"must be an object",
		);
	}
	// SAFETY: the preceding tag and array checks establish a plain object.
	return value as JsonObject;
}

function array(value: JsonValue, path: string): readonly JsonValue[] {
	if (!Array.isArray(value)) {
		throw new CapabilityMatrixError(
			"INVALID_CAPABILITY_MATRIX",
			path,
			"must be an array",
		);
	}
	// SAFETY: the preceding tag check establishes a primitive string value.
	return value;
}

function text(value: JsonValue, path: string): string {
	if (tagOf.call(value) !== "[object String]") {
		throw new CapabilityMatrixError(
			"INVALID_CAPABILITY_MATRIX",
			path,
			"must be a string",
		);
	}
	// SAFETY: the preceding tag check establishes a primitive string value.
	return value as string;
}

function nonEmptyText(value: JsonValue, path: string): string {
	const parsed = text(value, path);
	if (parsed.trim().length === 0) {
		throw new CapabilityMatrixError(
			"INVALID_CAPABILITY_MATRIX",
			path,
			"must be a non-empty string",
		);
	}
	return parsed;
}

function instant(value: JsonValue, path: string): number {
	if (tagOf.call(value) !== "[object Number]" || !Number.isInteger(value)) {
		throw new CapabilityMatrixError(
			"INVALID_CAPABILITY_MATRIX",
			path,
			"must be an integer epoch-millisecond instant",
		);
	}
	// SAFETY: the preceding tag and integer checks establish a numeric instant.
	return value as number;
}

function boolean(value: JsonValue, path: string): boolean {
	if (value !== true && value !== false) {
		throw new CapabilityMatrixError(
			"INVALID_CAPABILITY_MATRIX",
			path,
			"must be a boolean",
		);
	}
	return value;
}

function digest(value: JsonValue, path: string): string {
	const parsed = text(value, path);
	if (!DIGEST_PATTERN.test(parsed)) {
		throw new CapabilityMatrixError(
			"INVALID_CAPABILITY_MATRIX",
			path,
			"must be a lowercase sha256:<hex> digest",
		);
	}
	return parsed;
}

function member<T extends string>(
	vocabulary: readonly T[],
	value: JsonValue,
	path: string,
): T {
	const parsed = text(value, path);
	// SAFETY: vocabulary is a readonly string literal collection by contract.
	if (!(vocabulary as readonly string[]).includes(parsed)) {
		throw new CapabilityMatrixError(
			"UNKNOWN_VOCABULARY",
			path,
			`${JSON.stringify(parsed)} is not one of ${vocabulary.join(", ")}`,
		);
	}
	// SAFETY: includes() established that parsed is a member of vocabulary.
	return parsed as T;
}

/** Definition ids must arrive sorted and unique, or the digest is unstable. */
function definitionIds(value: JsonValue, path: string): readonly string[] {
	const entries = array(value, path).map((entry, index) =>
		nonEmptyText(entry, `${path}[${index}]`),
	);
	for (let index = 1; index < entries.length; index += 1) {
		const previous = entries[index - 1];
		const current = entries[index];
		if (previous === undefined || current === undefined) continue;
		if (previous >= current) {
			throw new CapabilityMatrixError(
				"INVALID_CAPABILITY_MATRIX",
				path,
				"definition ids must be sorted and unique",
			);
		}
	}
	return entries;
}

function bucket(value: JsonValue, path: string): CapabilityMatrixBucket {
	const record = object(value, path);
	const available = definitionIds(record.available, `${path}.available`);
	const unavailable = definitionIds(record.unavailable, `${path}.unavailable`);
	const availableSet = new Set(available);
	for (const id of unavailable) {
		if (availableSet.has(id)) {
			throw new CapabilityMatrixError(
				"INVALID_CAPABILITY_MATRIX",
				path,
				`definition ${id} is reported as both available and unavailable`,
			);
		}
	}
	return { available, unavailable };
}

function buckets(value: JsonValue, path: string): CapabilityMatrixBuckets {
	const record = object(value, path);
	return {
		native: bucket(record.native, `${path}.native`),
		pack: bucket(record.pack, `${path}.pack`),
		bridge: bucket(record.bridge, `${path}.bridge`),
		substrate: bucket(record.substrate, `${path}.substrate`),
		sponsor: bucket(record.sponsor, `${path}.sponsor`),
	};
}

function unavailability(
	value: JsonValue,
	path: string,
): readonly CandidateUnavailability[] {
	return array(value, path).map((entry, index) => {
		const record = object(entry, `${path}[${index}]`);
		return {
			code: member(
				CANDIDATE_UNAVAILABILITY_CODES,
				record.code,
				`${path}[${index}].code`,
			),
			detail: text(record.detail, `${path}[${index}].detail`),
		};
	});
}

function candidate(
	value: JsonValue,
	path: string,
	coordinate: CapabilityMatrixCoordinate,
): CapabilityMatrixCandidate {
	const record = object(value, path);
	const primitive = text(record.primitive, `${path}.primitive`);
	const runtime = text(record.runtime, `${path}.runtime`);
	if (!isBindlePrimitive(primitive) || !isBindleRuntime(runtime)) {
		throw new CapabilityMatrixError(
			"UNKNOWN_VOCABULARY",
			path,
			`${primitive}/${runtime} is not a Bindle primitive and runtime pair`,
		);
	}
	// A candidate filed under the wrong cell would make every per-cell count a
	// lie while the grid still looked complete.
	if (primitive !== coordinate.primitive || runtime !== coordinate.runtime) {
		throw new CapabilityMatrixError(
			"INVALID_CAPABILITY_MATRIX",
			path,
			`candidate is filed under ${coordinate.key} but claims ${primitive}/${runtime}`,
		);
	}
	const available = boolean(record.available, `${path}.available`);
	const reasons = unavailability(
		record.unavailability,
		`${path}.unavailability`,
	);
	if (available !== (reasons.length === 0)) {
		throw new CapabilityMatrixError(
			"INVALID_CAPABILITY_MATRIX",
			path,
			"available must be true exactly when no unavailability reason is recorded",
		);
	}
	const expiresAt = record.evidenceExpiresAtMs;
	const conformanceRef = record.conformanceRef;
	const parsed: Omit<
		CapabilityMatrixCandidate,
		"evidenceExpiresAtMs" | "conformanceRef"
	> & {
		evidenceExpiresAtMs?: number;
		conformanceRef?: string;
	} = {
		primitive,
		runtime,
		definitionId: nonEmptyText(record.definitionId, `${path}.definitionId`),
		providerId: nonEmptyText(record.providerId, `${path}.providerId`),
		profileId: nonEmptyText(record.profileId, `${path}.profileId`),
		realization: member(
			REALIZATION_KINDS,
			record.realization,
			`${path}.realization`,
		),
		bucket: member(CANDIDATE_BUCKETS, record.bucket, `${path}.bucket`),
		available,
		evidenceState: member(
			["fresh", "absent", "future-dated", "aged", "expired"] as const,
			record.evidenceState,
			`${path}.evidenceState`,
		),
		conformance: member(
			["pass", "fail", "unknown"] as const,
			record.conformance,
			`${path}.conformance`,
		),
		unavailability: reasons,
	};
	if (expiresAt !== undefined) {
		parsed.evidenceExpiresAtMs = instant(
			expiresAt,
			`${path}.evidenceExpiresAtMs`,
		);
	}
	if (conformanceRef !== undefined) {
		parsed.conformanceRef = nonEmptyText(
			conformanceRef,
			`${path}.conformanceRef`,
		);
	}
	return parsed;
}

function cell(
	value: JsonValue,
	path: string,
	coordinate: CapabilityMatrixCoordinate,
): CapabilityMatrixCell {
	const record = object(value, path);
	if (text(record.key, `${path}.key`) !== coordinate.key) {
		throw new CapabilityMatrixError(
			"INCOMPLETE_GRID",
			path,
			`expected cell ${coordinate.key} in canonical order, found ${String(record.key)}`,
		);
	}
	const parsedBuckets = buckets(record.buckets, `${path}.buckets`);
	const verdict = member<CoverageVerdict>(
		COVERAGE_VERDICTS,
		record.verdict,
		`${path}.verdict`,
	);
	// The verdict is a pure function of the buckets, so a recorded verdict that
	// disagrees with them is evidence the record was edited by hand.
	const derived = deriveCoverageVerdict(parsedBuckets);
	if (verdict !== derived) {
		throw new CapabilityMatrixError(
			"INVALID_CAPABILITY_MATRIX",
			path,
			`verdict ${verdict} does not follow from the buckets, which imply ${derived}`,
		);
	}
	const candidates = array(record.candidates, `${path}.candidates`).map(
		(entry, index) =>
			candidate(entry, `${path}.candidates[${index}]`, coordinate),
	);
	const bucketed = new Set<CandidateBucket>(
		candidates.map((entry) => entry.bucket),
	);
	for (const name of CANDIDATE_BUCKETS) {
		const occupancy = parsedBuckets[name];
		const listed = occupancy.available.length + occupancy.unavailable.length;
		if (listed > 0 && !bucketed.has(name)) {
			throw new CapabilityMatrixError(
				"INVALID_CAPABILITY_MATRIX",
				`${path}.buckets.${name}`,
				"lists definition ids that no candidate in the cell accounts for",
			);
		}
	}
	return {
		key: coordinate.key,
		primitive: coordinate.primitive,
		runtime: coordinate.runtime,
		verdict,
		buckets: parsedBuckets,
		candidates,
	};
}

function exclusion(value: JsonValue, path: string): CapabilityMatrixExclusion {
	const record = object(value, path);
	return {
		definitionId: nonEmptyText(record.definitionId, `${path}.definitionId`),
		profileId: text(record.profileId, `${path}.profileId`),
		code: member(MATRIX_EXCLUSION_CODES, record.code, `${path}.code`),
		detail: text(record.detail, `${path}.detail`),
	};
}

/**
 * Parse an untrusted matrix document into a `CapabilityMatrix`.
 *
 * Rejects, rather than repairs: a grid missing a cell is not a matrix with a
 * gap, it is not a matrix.
 */
export function parseCapabilityMatrix(
	value: CapabilityMatrixDocument,
): CapabilityMatrix {
	const record = object(value, "matrix");
	if (record.schemaVersion !== CAPABILITY_MATRIX_SCHEMA_VERSION) {
		throw new CapabilityMatrixError(
			"INVALID_CAPABILITY_MATRIX",
			"matrix.schemaVersion",
			`unsupported schema version ${String(record.schemaVersion)}`,
		);
	}
	const rawCells = array(record.cells, "matrix.cells");
	if (rawCells.length !== CAPABILITY_MATRIX_COORDINATES.length) {
		throw new CapabilityMatrixError(
			"INCOMPLETE_GRID",
			"matrix.cells",
			`a matrix carries exactly one cell per primitive/runtime pair (${CAPABILITY_MATRIX_COORDINATES.length}), found ${rawCells.length}`,
		);
	}

	const body = {
		schemaVersion: CAPABILITY_MATRIX_SCHEMA_VERSION,
		evaluatedAtMs: instant(record.evaluatedAtMs, "matrix.evaluatedAtMs"),
		profileRegistryDigest: digest(
			record.profileRegistryDigest,
			"matrix.profileRegistryDigest",
		),
		trustBundleDigest: digest(
			record.trustBundleDigest,
			"matrix.trustBundleDigest",
		),
		cells: CAPABILITY_MATRIX_COORDINATES.map((coordinate, index) =>
			cell(rawCells[index], `matrix.cells[${index}]`, coordinate),
		),
		excluded: array(record.excluded, "matrix.excluded").map((entry, index) =>
			exclusion(entry, `matrix.excluded[${index}]`),
		),
	} as const;

	const recorded = digest(record.digest, "matrix.digest");
	const recomputed = capabilityMatrixDigest(body);
	if (recorded !== recomputed) {
		throw new CapabilityMatrixError(
			"DIGEST_MISMATCH",
			"matrix.digest",
			`recorded digest ${recorded} does not describe the body, which digests to ${recomputed}`,
		);
	}

	return { ...body, digest: recomputed };
}

/** Non-throwing variant, for callers surveying several stored matrices. */
export function tryParseCapabilityMatrix(
	value: CapabilityMatrixDocument,
): CapabilityMatrix | undefined {
	try {
		return parseCapabilityMatrix(value);
	} catch {
		return undefined;
	}
}
