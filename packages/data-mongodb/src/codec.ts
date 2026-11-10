/**
 * Canonical record ↔ MongoDB document.
 *
 * One document per record:
 *
 *   { _id: { t: <tenant>, k: <canonical key> }, <field>: <native value>, … }
 *
 * Tenant and key sit in `_id`, so the `_id` index is the tenant index, a
 * tenant is one contiguous `_id` range, and a delete event (which carries
 * only the document key) still names both. Fields are top-level in schema
 * order, each in the BSON type the annex in `./declaration.ts` declares.
 * Undeclared fields of an open schema go under `_open`, a name no declared
 * field can take.
 *
 * Every rule here follows one principle: a value is stored exactly or it is
 * refused. `encode*` throws `MONGODB_VALUE_NOT_REPRESENTABLE` for a canonical
 * value the native type cannot hold; `decode*` throws
 * `MONGODB_NON_CANONICAL_VALUE` for a stored value with no canonical form.
 * Neither error ever quotes the value.
 */
import {
	type CanonicalRecord,
	type CanonicalType,
	type DatasetField,
	type DatasetSchema,
	type JsonObject,
	type JsonValue,
	parseCanonicalRecord,
} from "@hobo/data-core";
import {
	DECIMAL128_MAX_DIGITS,
	fromDecimal128Text,
	toDecimal128Text,
} from "./decimal.js";
import { MongoDataError } from "./errors.js";
import {
	binaryOf,
	dateOf,
	type MongoDocument,
	type MongoValue,
	mongoBinary,
	mongoDate,
	mongoDecimal,
	mongoDouble,
	mongoLong,
	mongoTypeOf,
	wrappedText,
} from "./extended-json.js";
import {
	isJsonArray,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	isWellFormedText,
} from "./json.js";

/** Where undeclared fields of an open schema are kept. */
// public-contract: reserved document field holding an open schema's undeclared fields.
export const MONGO_OPEN_FIELD = "_open";

const MS_PER_DAY = 86_400_000;
const BINARY_GENERIC = "00";
const BINARY_UUID = "04";
/** The one layout a canonical timestamp has: UTC, six fractional digits. */
const TIMESTAMP_LAYOUT =
	"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{6}Z$";

function unrepresentable(
	field: string,
	type: CanonicalType | "key",
	constraint: string,
	message: string,
): never {
	throw new MongoDataError(
		"MONGODB_VALUE_NOT_REPRESENTABLE",
		`${field}: ${message}`,
		{ detail: { field, type, constraint } },
	);
}

function nonCanonical(
	field: string,
	type: CanonicalType | "key",
	found: string,
): never {
	throw new MongoDataError(
		"MONGODB_NON_CANONICAL_VALUE",
		`${field}: the stored ${found} value has no canonical ${type} form; it was not written through this binding`,
		{ detail: { field, type, found } },
	);
}

/** Refuse text a BSON string cannot hold exactly. */
export function storableText(
	text: string,
	field: string,
	type: CanonicalType | "key",
): string {
	if (!isWellFormedText(text)) {
		unrepresentable(
			field,
			type,
			"WELL_FORMED_UNICODE",
			"text with an unpaired surrogate has no UTF-8 encoding and would be stored altered",
		);
	}
	return text;
}

// ── document ids ────────────────────────────────────────────────────────────

/** The `_id` of a record. Field order is part of the identity. */
export function documentId(tenant: string, key: string): MongoDocument {
	return {
		t: storableText(tenant, "tenant", "key"),
		k: storableText(key, "key", "key"),
	};
}

export interface DocumentIdentity {
	readonly tenant: string;
	readonly key: string;
}

export function identityOf(id: MongoValue | undefined): DocumentIdentity {
	if (isJsonObject(id) && isJsonString(id.t) && isJsonString(id.k)) {
		return { tenant: id.t, key: id.k };
	}
	return nonCanonical("_id", "key", mongoTypeOf(id ?? null));
}

// ── json ────────────────────────────────────────────────────────────────────

function encodeJson(value: JsonValue, field: string): MongoValue {
	if (value === null || isJsonBoolean(value)) return value;
	if (isJsonString(value)) return storableText(value, field, "json");
	if (isJsonNumber(value)) {
		if (!Number.isFinite(value)) {
			unrepresentable(
				field,
				"json",
				"FINITE_NUMBER",
				"a JSON number is finite",
			);
		}
		return mongoDouble(value);
	}
	if (isJsonArray(value)) return value.map((item) => encodeJson(item, field));
	return Object.fromEntries(
		Object.keys(value).map((key) => {
			if (key.startsWith("$") || key.includes("\u0000")) {
				unrepresentable(
					field,
					"json",
					"OBJECT_KEY",
					"an object key may not start with `$` or contain NUL: MongoDB reserves the first and cannot store the second",
				);
			}
			return [
				storableText(key, field, "json"),
				encodeJson(value[key] ?? null, field),
			];
		}),
	);
}

function decodeJson(value: MongoValue, field: string): JsonValue {
	if (value === null || isJsonBoolean(value) || isJsonString(value)) {
		return value;
	}
	if (isJsonNumber(value)) {
		return Number.isFinite(value) ? value : nonCanonical(field, "json", "NaN");
	}
	if (isJsonArray(value)) return value.map((item) => decodeJson(item, field));
	const type = mongoTypeOf(value);
	if (type === "object") {
		return Object.fromEntries(
			Object.keys(value).map((key) => [
				key,
				decodeJson(value[key] ?? null, field),
			]),
		);
	}
	const text =
		wrappedText(value, "$numberDouble") ??
		wrappedText(value, "$numberInt") ??
		wrappedText(value, "$numberLong");
	const parsed = text === undefined ? Number.NaN : Number(text);
	// A JSON number is a double. An int32 always is one; an int64 only when it
	// is a safe integer; NaN and the infinities never are.
	if (
		!Number.isFinite(parsed) ||
		(type === "long" && !Number.isSafeInteger(parsed))
	) {
		return nonCanonical(field, "json", type);
	}
	return parsed;
}

// ── scalar types ────────────────────────────────────────────────────────────

function encodeDecimal(value: string, field: string): MongoValue {
	const text = toDecimal128Text(value);
	if (text === undefined) {
		return unrepresentable(
			field,
			"decimal",
			"DECIMAL128_PRECISION",
			`Decimal128 holds at most ${DECIMAL128_MAX_DIGITS} significant digits; this value needs more and would be rounded`,
		);
	}
	return mongoDecimal(text);
}

function encodeDate(value: string): MongoValue {
	const [year = 0, month = 1, day = 1] = value.split("-").map(Number);
	const instant = new Date(0);
	// setUTCFullYear takes years 0–99 literally; Date.UTC would add 1900.
	instant.setUTCFullYear(year, month - 1, day);
	return mongoDate(instant.getTime());
}

function pad(value: number, width: number): string {
	return String(value).padStart(width, "0");
}

function decodeDate(value: MongoValue, field: string): string {
	const epochMs = dateOf(value);
	if (epochMs === undefined || epochMs % MS_PER_DAY !== 0) {
		return nonCanonical(field, "date", mongoTypeOf(value));
	}
	const instant = new Date(epochMs);
	const year = instant.getUTCFullYear();
	if (Number.isNaN(year) || year < 0 || year > 9999) {
		return nonCanonical(field, "date", "date");
	}
	return `${pad(year, 4)}-${pad(instant.getUTCMonth() + 1, 2)}-${pad(instant.getUTCDate(), 2)}`;
}

function encodeUuid(value: string): MongoValue {
	return mongoBinary(
		Buffer.from(value.replaceAll("-", ""), "hex").toString("base64"),
		BINARY_UUID,
	);
}

function decodeUuid(value: MongoValue, field: string): string {
	const binary = binaryOf(value);
	const bytes =
		binary === undefined ? undefined : Buffer.from(binary.base64, "base64");
	if (
		binary === undefined ||
		bytes === undefined ||
		binary.subType !== BINARY_UUID ||
		bytes.length !== 16
	) {
		return nonCanonical(field, "uuid", mongoTypeOf(value));
	}
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function decodeBytes(value: MongoValue, field: string): string {
	return (
		binaryOf(value)?.base64 ?? nonCanonical(field, "bytes", mongoTypeOf(value))
	);
}

function encodeEncrypted(value: JsonValue, field: string): MongoValue {
	if (!isJsonObject(value)) {
		return unrepresentable(
			field,
			"encrypted",
			"CANONICAL_FORM",
			"not a canonical encrypted value",
		);
	}
	const { alg, keyRef, ciphertext } = value;
	if (
		!isJsonString(alg) ||
		!isJsonString(keyRef) ||
		!isJsonString(ciphertext)
	) {
		return unrepresentable(
			field,
			"encrypted",
			"CANONICAL_FORM",
			"not a canonical encrypted value",
		);
	}
	return {
		alg: storableText(alg, field, "encrypted"),
		keyRef: storableText(keyRef, field, "encrypted"),
		ciphertext: mongoBinary(ciphertext, BINARY_GENERIC),
	};
}

function decodeEncrypted(value: MongoValue, field: string): JsonValue {
	if (mongoTypeOf(value) !== "object" || !isJsonObject(value)) {
		return nonCanonical(field, "encrypted", mongoTypeOf(value));
	}
	const { alg, keyRef } = value;
	const ciphertext = binaryOf(value.ciphertext ?? null);
	if (
		!isJsonString(alg) ||
		!isJsonString(keyRef) ||
		ciphertext === undefined ||
		Object.keys(value).length !== 3
	) {
		return nonCanonical(field, "encrypted", "object");
	}
	return { alg, keyRef, ciphertext: ciphertext.base64 };
}

function canonicalText(
	value: JsonValue,
	field: string,
	type: CanonicalType,
): string {
	return isJsonString(value)
		? value
		: unrepresentable(
				field,
				type,
				"CANONICAL_FORM",
				`not a canonical ${type} value`,
			);
}

/** One canonical value, already in normal form, as its native BSON value. */
export function encodeValue(
	type: CanonicalType,
	value: JsonValue,
	field: string,
): MongoValue {
	switch (type) {
		case "bool":
			return isJsonBoolean(value)
				? value
				: unrepresentable(
						field,
						type,
						"CANONICAL_FORM",
						"not a canonical bool",
					);
		case "int64":
			return mongoLong(canonicalText(value, field, type));
		case "float64":
			return isJsonNumber(value) && Number.isFinite(value)
				? mongoDouble(value)
				: unrepresentable(
						field,
						type,
						"CANONICAL_FORM",
						"not a canonical float64",
					);
		case "decimal":
			return encodeDecimal(canonicalText(value, field, type), field);
		case "string":
			return storableText(canonicalText(value, field, type), field, type);
		case "bytes":
			return mongoBinary(canonicalText(value, field, type), BINARY_GENERIC);
		case "timestamp":
			return canonicalText(value, field, type);
		case "date":
			return encodeDate(canonicalText(value, field, type));
		case "uuid":
			return encodeUuid(canonicalText(value, field, type));
		case "json":
			return encodeJson(value, field);
		case "encrypted":
			return encodeEncrypted(value, field);
	}
}

/**
 * One stored value as the raw JSON the canonical parser accepts for its
 * type. Normalisation (and the last word on validity) is the parser's.
 */
export function decodeValue(
	type: CanonicalType,
	value: MongoValue,
	field: string,
): JsonValue {
	switch (type) {
		case "bool":
			return isJsonBoolean(value)
				? value
				: nonCanonical(field, type, mongoTypeOf(value));
		case "int64":
			return (
				wrappedText(value, "$numberLong") ??
				wrappedText(value, "$numberInt") ??
				nonCanonical(field, type, mongoTypeOf(value))
			);
		case "float64": {
			const text = wrappedText(value, "$numberDouble");
			const parsed = text === undefined ? Number.NaN : Number(text);
			return Number.isFinite(parsed)
				? parsed
				: nonCanonical(field, type, mongoTypeOf(value));
		}
		case "decimal": {
			const text = wrappedText(value, "$numberDecimal");
			return (
				(text === undefined ? undefined : fromDecimal128Text(text)) ??
				nonCanonical(field, type, mongoTypeOf(value))
			);
		}
		case "string":
		case "timestamp":
			return isJsonString(value)
				? value
				: nonCanonical(field, type, mongoTypeOf(value));
		case "bytes":
			return decodeBytes(value, field);
		case "date":
			return decodeDate(value, field);
		case "uuid":
			return decodeUuid(value, field);
		case "json":
			return decodeJson(value, field);
		case "encrypted":
			return decodeEncrypted(value, field);
	}
}

// ── documents ───────────────────────────────────────────────────────────────

/** The document that stores `record` under `(tenant, key)`. */
export function encodeDocument(
	schema: DatasetSchema,
	tenant: string,
	key: string,
	record: CanonicalRecord,
): MongoDocument {
	// Parse, don't validate: whatever arrives is put in normal form first, so
	// the encoders below only ever see canonical values.
	const canonical = parseCanonicalRecord(schema, record);
	const declared = new Set(schema.fields.map((field) => field.name));
	const fields = schema.fields.map((field): [string, MongoValue] => {
		const value = canonical[field.name] ?? null;
		return [
			field.name,
			value === null ? null : encodeValue(field.type, value, field.name),
		];
	});
	const undeclared = Object.keys(canonical).filter(
		(name) => !declared.has(name),
	);
	const open: [string, MongoValue][] =
		undeclared.length === 0
			? []
			: [
					[
						MONGO_OPEN_FIELD,
						encodeJson(
							Object.fromEntries(
								undeclared.map((name) => [name, canonical[name] ?? null]),
							),
							MONGO_OPEN_FIELD,
						),
					],
				];
	return Object.fromEntries([
		["_id", documentId(tenant, key)],
		...fields,
		...open,
	]);
}

export interface DecodedDocument extends DocumentIdentity {
	readonly record: CanonicalRecord;
}

/** The canonical record a stored document holds, and where it sits. */
export function decodeDocument(
	schema: DatasetSchema,
	document: MongoDocument,
): DecodedDocument {
	const identity = identityOf(document._id);
	const declared = new Set(schema.fields.map((field) => field.name));
	for (const name of Object.keys(document)) {
		if (name === "_id" || declared.has(name)) continue;
		if (name === MONGO_OPEN_FIELD && schema.open) continue;
		nonCanonical(name, "json", "undeclared field");
	}
	const fields = schema.fields.map((field): [string, JsonValue] => {
		const value = document[field.name] ?? null;
		return [
			field.name,
			value === null ? null : decodeValue(field.type, value, field.name),
		];
	});
	const stored = document[MONGO_OPEN_FIELD];
	const open = stored === undefined ? {} : decodeJson(stored, MONGO_OPEN_FIELD);
	if (!isJsonObject(open)) {
		return nonCanonical(MONGO_OPEN_FIELD, "json", mongoTypeOf(stored ?? null));
	}
	const undeclared = Object.keys(open).map((name): [string, JsonValue] => [
		name,
		open[name] ?? null,
	]);
	return {
		...identity,
		record: parseCanonicalRecord(
			schema,
			Object.fromEntries([...undeclared, ...fields]),
		),
	};
}

// ── the collection validator ────────────────────────────────────────────────

const JSON_BSON_TYPES = [
	"object",
	"array",
	"string",
	"double",
	"int",
	"long",
	"bool",
];

function nativeTypes(type: CanonicalType): readonly string[] {
	switch (type) {
		case "bool":
			return ["bool"];
		case "int64":
			return ["long"];
		case "float64":
			return ["double"];
		case "decimal":
			return ["decimal"];
		case "string":
		case "timestamp":
			return ["string"];
		case "bytes":
		case "uuid":
			return ["binData"];
		case "date":
			return ["date"];
		case "json":
			return JSON_BSON_TYPES;
		case "encrypted":
			return ["object"];
	}
}

function fieldRule(field: DatasetField): JsonObject {
	const bsonType = [
		...nativeTypes(field.type),
		...(field.nullable ? ["null"] : []),
	];
	if (field.type === "timestamp") {
		return { bsonType, pattern: TIMESTAMP_LAYOUT };
	}
	if (field.type === "encrypted") {
		return {
			bsonType,
			required: ["alg", "keyRef", "ciphertext"],
			additionalProperties: false,
			properties: {
				alg: { bsonType: "string" },
				keyRef: { bsonType: "string" },
				ciphertext: { bsonType: "binData" },
			},
		};
	}
	return { bsonType };
}

/**
 * The `$jsonSchema` validator a dataset's collection is created with. It pins
 * every declared field to its native BSON type, so a writer with its own
 * connection cannot store a string where the schema says `long` without
 * explicitly bypassing validation. It is what makes the annex's `exact` read
 * edges true of the store and not only of this binding.
 */
export function datasetValidator(schema: DatasetSchema): MongoDocument {
	const properties = Object.fromEntries<JsonValue>([
		[
			"_id",
			{
				bsonType: "object",
				required: ["t", "k"],
				additionalProperties: false,
				properties: { t: { bsonType: "string" }, k: { bsonType: "string" } },
			},
		],
		...schema.fields.map((field): [string, JsonValue] => [
			field.name,
			fieldRule(field),
		]),
		...(schema.open
			? [[MONGO_OPEN_FIELD, { bsonType: "object" }] as const]
			: []),
	]);
	return {
		$jsonSchema: {
			bsonType: "object",
			required: ["_id", ...schema.fields.map((field) => field.name)],
			additionalProperties: false,
			properties,
		},
	};
}
