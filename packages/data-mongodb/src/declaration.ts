/**
 * What the MongoDB engine declares about itself (ADR-0177 decisions 2 and 10).
 *
 * The declaration is the honest part of the package. Everything a selector
 * needs to refuse a pattern MongoDB cannot run, and everything a plan needs
 * to say where a value might not survive, is stated here rather than
 * discovered in production.
 */
import {
	type EngineDeclaration,
	type JsonObject,
	parseEngineDeclaration,
	type SpiPortName,
} from "@hobo/data-core";

// public-contract: engine id reported in the MongoDB engine declaration.
export const MONGO_ENGINE_ID = "mongodb";
// public-contract: capability profile id the MongoDB engine implements.
export const MONGO_ENGINE_PROFILE = "data.mongodb/v1";

/**
 * Impedance this engine can report (ADR-0144). The list is closed: each code
 * is a real limit of MongoDB or of this binding, stated so nobody over-claims
 * fidelity.
 */
export const MONGO_IMPEDANCE_CODES = [
	/** MongoDB has no triggers: the fence stops writers that go through the binding, not a client with its own connection. */
	"MONGODB_FENCE_ENTRY_POINT",
	/** Change streams and multi-document transactions need a replica set or a sharded cluster; a standalone server offers neither. */
	"MONGODB_REPLICA_SET_REQUIRED",
	/** A capture position is resumable only while the oplog still holds it; a reader that falls outside the window must re-seed. */
	"MONGODB_CAPTURE_OPLOG_WINDOW",
	/** A write that changes nothing (an identical replace, a delete of an absent record) produces no change event. */
	"MONGODB_CAPTURE_SKIPS_NOOP_WRITES",
	/** An in-place update by another client is captured as of the change only while the collection has `changeStreamPreAndPostImages` on, which costs a stored pre-image per change. */
	"MONGODB_CAPTURE_NEEDS_CHANGE_IMAGES",
	/** One atomic unit is one transaction: bounded by the 60 s lifetime limit and by cache, so a very large write batch or retire scope is refused. */
	"MONGODB_TRANSACTION_BOUNDS",
	/** A record is one BSON document: under 16 MiB. */
	"MONGODB_DOCUMENT_SIZE_LIMIT",
	/** Decimal128 holds 34 significant digits; a longer decimal is refused, never rounded. */
	"MONGODB_DECIMAL128_PRECISION",
	/** BSON dates are millisecond precision, so timestamps are stored as canonical text and are not BSON dates to native queries. */
	"MONGODB_TIMESTAMP_STORED_AS_TEXT",
	/** BSON strings are UTF-8: text with an unpaired surrogate is refused, never stored as U+FFFD. */
	"MONGODB_TEXT_WELL_FORMED_ONLY",
	/** JSON object keys may not start with `$` or contain NUL, and JSON numbers are stored as doubles. */
	"MONGODB_JSON_KEY_RESTRICTIONS",
	/** The scan behind a snapshot is not a point-in-time image; the executors converge it with the tail. */
	"MONGODB_SNAPSHOT_FUZZY",
	/** There is no SQL surface and no transactional DDL: no `schema` port, so `in-place-evolve` is never eligible. */
	"MONGODB_NO_SCHEMA_PORT",
	/** Indexes, collations, views, time-series and capped options, and server-side functions do not cross the hub. */
	"MONGODB_NATIVE_OBJECTS_NOT_CARRIED",
] as const;

export type MongoImpedanceCode = (typeof MONGO_IMPEDANCE_CODES)[number];

const WELL_FORMED_NOTE =
	"text must be well-formed Unicode: an unpaired surrogate has no UTF-8 encoding and is refused";

/**
 * How each canonical type lands in BSON, and how faithful the trip is.
 *
 * `read` is judged against the collection as this binding creates it — with a
 * `$jsonSchema` validator that pins each field's BSON type. Where the native
 * type is still wider than the canonical one under that validator (a double
 * can be NaN, a string can be any text), the edge is `widening` and the stray
 * value is refused on read, never coerced.
 */
export const MONGO_TYPE_MAPPING: JsonObject = Object.freeze({
	engine: MONGO_ENGINE_ID,
	edges: [
		{
			canonical: "bool",
			native: "bool",
			write: "exact",
			read: "exact",
			note: "",
		},
		{
			canonical: "int64",
			native: "long",
			write: "exact",
			read: "exact",
			note: "",
		},
		{
			canonical: "float64",
			native: "double",
			write: "exact",
			read: "widening",
			note: "a BSON double can be NaN or infinite; those have no canonical form and are refused on read",
		},
		{
			canonical: "decimal",
			native: "decimal (Decimal128)",
			write: "constrained",
			read: "widening",
			note: "at most 34 significant digits with an exponent in [-6176, 6111]; a decimal outside that is refused at write, never rounded. A native NaN or infinity is refused on read",
		},
		{
			canonical: "string",
			native: "string",
			write: "constrained",
			read: "exact",
			note: WELL_FORMED_NOTE,
		},
		{
			canonical: "bytes",
			native: "binData (subtype 0)",
			write: "exact",
			read: "exact",
			note: "",
		},
		{
			canonical: "timestamp",
			native: "string (RFC 3339, UTC, six fractional digits)",
			write: "exact",
			read: "widening",
			note: "stored as canonical text because a BSON date is millisecond precision and would drop microseconds; the validator pins the layout, and text that is not a timestamp is refused on read",
		},
		{
			canonical: "date",
			native: "date (00:00:00.000 UTC)",
			write: "exact",
			read: "widening",
			note: "a BSON date is an instant; one that is not a UTC midnight in years 0000–9999 is refused on read",
		},
		{
			canonical: "uuid",
			native: "binData (subtype 4)",
			write: "exact",
			read: "widening",
			note: "the validator pins binData but not its subtype or length; binary data that is not a 16-byte subtype 4 value is refused on read",
		},
		{
			canonical: "json",
			native: "object | array | string | double | bool | null",
			write: "constrained",
			read: "widening",
			note: `object keys may not start with "$" or contain NUL; ${WELL_FORMED_NOTE}; numbers are stored as doubles. A nested BSON value with no JSON form (date, ObjectId, Decimal128, a long beyond 2^53) is refused on read`,
		},
		{
			canonical: "encrypted",
			native: "object { alg: string, keyRef: string, ciphertext: binData }",
			write: "constrained",
			read: "exact",
			note: `the ciphertext is stored as bytes and never interpreted; alg and keyRef are strings, so ${WELL_FORMED_NOTE}`,
		},
	],
});

const PORTS_WITH_CAPTURE: readonly SpiPortName[] = [
	"datasets",
	"records",
	"snapshot",
	"capture",
	"apply",
	"verify",
	"fence",
	"retire",
];

export interface MongoDeclarationOptions {
	/** False for a deployment that cannot open change streams. */
	readonly capture: boolean;
}

/**
 * The declaration for a MongoDB binding.
 *
 * - No `schema` port: there is no SQL surface, so `in-place-evolve` is
 *   ineligible by declaration.
 * - `fenceEnforcement: "entry-point"`: MongoDB has no triggers. The fence is
 *   checked inside the transaction of every write that goes through this
 *   binding; a client holding its own connection is not stopped.
 * - `snapshotConsistency: "fuzzy"`: the seed is a keyset scan, not a
 *   point-in-time image.
 * - `captureOrdering: "global"`: a change stream is totally ordered by
 *   cluster time. Without change streams the port is absent and the ordering
 *   is `none`.
 */
export function mongoEngineDeclaration(
	options: MongoDeclarationOptions,
): EngineDeclaration {
	return parseEngineDeclaration({
		engine: MONGO_ENGINE_ID,
		profile: MONGO_ENGINE_PROFILE,
		paradigm: "document",
		ports: PORTS_WITH_CAPTURE.filter(
			(port) => options.capture || port !== "capture",
		),
		captureOrdering: options.capture ? "global" : "none",
		fenceEnforcement: "entry-point",
		snapshotConsistency: "fuzzy",
		ddlTransactional: false,
		nativeProfiles: [],
		typeMapping: MONGO_TYPE_MAPPING,
		impedance: [...MONGO_IMPEDANCE_CODES],
	});
}
