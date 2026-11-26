import {
	type EngineDeclaration,
	type JsonObject,
	parseEngineDeclaration,
	type SpiPortName,
} from "@hobo/data-core";

export const MONGO_ENGINE_ID = "mongodb";
export const MONGO_ENGINE_PROFILE = "data.mongodb/v1";

export const MONGO_IMPEDANCE_CODES = [
	"MONGODB_FENCE_ENTRY_POINT",
	"MONGODB_REPLICA_SET_REQUIRED",
	"MONGODB_CAPTURE_OPLOG_WINDOW",
	"MONGODB_CAPTURE_ACKNOWLEDGE_RELEASES_NOTHING",
	"MONGODB_CAPTURE_SKIPS_NOOP_WRITES",
	"MONGODB_CAPTURE_NEEDS_CHANGE_IMAGES",
	"MONGODB_TRANSACTION_BOUNDS",
	"MONGODB_DOCUMENT_SIZE_LIMIT",
	"MONGODB_DECIMAL128_PRECISION",
	"MONGODB_TIMESTAMP_STORED_AS_TEXT",
	"MONGODB_TEXT_WELL_FORMED_ONLY",
	"MONGODB_JSON_KEY_RESTRICTIONS",
	"MONGODB_SNAPSHOT_FUZZY",
	"MONGODB_NO_SCHEMA_PORT",
	"MONGODB_NATIVE_OBJECTS_NOT_CARRIED",
] as const;

export type MongoImpedanceCode = (typeof MONGO_IMPEDANCE_CODES)[number];

export const MONGO_MAX_RECORD_BYTES = 16 * 1024 * 1024;

export const MONGO_CONFORMANCE_DECLARED_LIMITS: Readonly<
	Record<string, MongoImpedanceCode>
> = Object.freeze({
	"capture.acknowledged-positions-are-final":
		"MONGODB_CAPTURE_ACKNOWLEDGE_RELEASES_NOTHING",
});

const WELL_FORMED_NOTE =
	"text must be well-formed Unicode: an unpaired surrogate has no UTF-8 encoding and is refused";

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
	readonly capture: boolean;
}

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
		maxRecordBytes: MONGO_MAX_RECORD_BYTES,
	});
}
