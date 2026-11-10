/**
 * The canonical record model — the hub every engine captures into and applies
 * out of (ADR-0177 decision 4).
 *
 * A dataset is a named set of keyed records. Its schema names each field's
 * canonical type; a record is a plain JSON object whose values are in the one
 * normal form that type allows. Normal form is the whole point: two engines
 * that store the same logical value differently (`1.50` and `1.5`, `+02:00`
 * and `Z`, a `bigint` and a decimal string) must produce byte-identical
 * canonical records, or a cross-engine digest comparison would report a
 * difference that is not there.
 *
 * Parse, don't validate: `parseDatasetSchema` and `parseCanonicalRecord` are
 * the only constructors, and everything downstream accepts the parsed types.
 */
import { DataCoreError } from "./errors.js";
import {
	canonicalEncode,
	freezeDeep,
	isJsonArray,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	sha256Hex,
} from "./json.js";

// public-contract: the schema id a canonical dataset schema is published under.
export const DATASET_SCHEMA_CONTRACT = "hobo.dataset-schema/v1";

export const CANONICAL_TYPES = [
	"bool",
	"int64",
	"float64",
	"decimal",
	"string",
	"bytes",
	"timestamp",
	"date",
	"uuid",
	"json",
	"encrypted",
] as const;

export type CanonicalType = (typeof CANONICAL_TYPES)[number];

/** Types a key field may use: totally ordered and exact in every engine. */
export const CANONICAL_KEY_TYPES: readonly CanonicalType[] = Object.freeze([
	"string",
	"int64",
	"uuid",
]);

// domain-view: parsed field; wire form is DatasetField in data-models/data_core.proto.
export interface DatasetField {
	readonly name: string;
	readonly type: CanonicalType;
	readonly nullable: boolean;
}

// domain-view: parsed schema, constructible only through parseDatasetSchema; wire form is DatasetSchema in data-models/data_core.proto.
export interface DatasetSchema {
	readonly contract: typeof DATASET_SCHEMA_CONTRACT;
	readonly name: string;
	/** Bumped on every change to fields; carried in each change envelope. */
	readonly version: number;
	readonly keyFields: readonly string[];
	readonly fields: readonly DatasetField[];
	/** Open schemas keep undeclared fields as `json`; closed schemas refuse them. */
	readonly open: boolean;
}

/** A record in canonical normal form. Keys are field names. */
export type CanonicalRecord = JsonObject;

/**
 * Portable identifier: lowercase snake case, at most 63 bytes. Every engine
 * this contract targets accepts it unquoted, which is what lets a dataset
 * name be a table name, a collection name, and a publication member.
 */
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{0,62}$/u;
const INT64_PATTERN = /^-?(0|[1-9][0-9]*)$/u;
const DECIMAL_PATTERN = /^-?[0-9]+(\.[0-9]+)?$/u;
const BASE64_PATTERN =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const DATE_PATTERN = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/u;
const UUID_PATTERN =
	/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
const TIMESTAMP_PATTERN =
	/^([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt ]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?(Z|z|[+-][0-9]{2}:?[0-9]{2})$/u;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

function invalidSchema(message: string, field: string): never {
	throw new DataCoreError("INVALID_DATASET_SCHEMA", message, {
		detail: { field },
	});
}

function invalidRecord(message: string, field: string): never {
	throw new DataCoreError("INVALID_RECORD", message, { detail: { field } });
}

export function isPortableIdentifier(value: string): boolean {
	return IDENTIFIER_PATTERN.test(value);
}

function isCanonicalType(value: string): value is CanonicalType {
	// SAFETY: membership test against the closed tuple of canonical type names.
	return (CANONICAL_TYPES as readonly string[]).includes(value);
}

function parseField(value: JsonValue | undefined, path: string): DatasetField {
	if (!isJsonObject(value)) invalidSchema("field must be an object", path);
	const name = value.name;
	if (!isJsonString(name) || !isPortableIdentifier(name)) {
		invalidSchema(
			"field name must be a lowercase snake_case identifier",
			`${path}.name`,
		);
	}
	const type = value.type;
	if (!isJsonString(type) || !isCanonicalType(type)) {
		invalidSchema(
			`field type must be one of ${CANONICAL_TYPES.join(", ")}`,
			`${path}.type`,
		);
	}
	const nullable = value.nullable ?? false;
	if (!isJsonBoolean(nullable)) {
		invalidSchema("nullable must be a boolean", `${path}.nullable`);
	}
	return Object.freeze({ name, type, nullable });
}

/** The one constructor for a `DatasetSchema`. Invalid input throws. */
export function parseDatasetSchema(
	value: JsonValue | undefined,
): DatasetSchema {
	if (!isJsonObject(value)) invalidSchema("schema must be an object", "schema");
	const name = value.name;
	if (!isJsonString(name) || !isPortableIdentifier(name)) {
		invalidSchema(
			"dataset name must be a lowercase snake_case identifier",
			"name",
		);
	}
	const version = value.version ?? 1;
	if (!isJsonNumber(version) || !Number.isInteger(version) || version < 1) {
		invalidSchema("version must be a positive integer", "version");
	}
	const rawFields = value.fields;
	if (!isJsonArray(rawFields) || rawFields.length === 0) {
		invalidSchema("fields must be a non-empty array", "fields");
	}
	const fields = rawFields.map((entry, index) =>
		parseField(entry, `fields[${index}]`),
	);
	const byName = new Map<string, DatasetField>();
	for (const field of fields) {
		if (byName.has(field.name)) {
			invalidSchema(`duplicate field ${field.name}`, "fields");
		}
		byName.set(field.name, field);
	}
	const rawKeys = value.keyFields;
	if (!isJsonArray(rawKeys) || rawKeys.length === 0) {
		invalidSchema("keyFields must be a non-empty array", "keyFields");
	}
	const keyFields: string[] = [];
	for (const entry of rawKeys) {
		if (!isJsonString(entry)) {
			invalidSchema("keyFields entries must be field names", "keyFields");
		}
		const field = byName.get(entry);
		if (field === undefined) {
			invalidSchema(`key field ${entry} is not declared`, "keyFields");
		}
		if (field.nullable || !CANONICAL_KEY_TYPES.includes(field.type)) {
			invalidSchema(
				`key field ${entry} must be non-nullable and one of ${CANONICAL_KEY_TYPES.join(", ")}`,
				"keyFields",
			);
		}
		if (keyFields.includes(entry)) {
			invalidSchema(`duplicate key field ${entry}`, "keyFields");
		}
		keyFields.push(entry);
	}
	const open = value.open ?? false;
	if (!isJsonBoolean(open)) invalidSchema("open must be a boolean", "open");
	return Object.freeze({
		contract: DATASET_SCHEMA_CONTRACT,
		name,
		version,
		keyFields: Object.freeze(keyFields),
		fields: Object.freeze(fields),
		open,
	});
}

export function schemaToJson(schema: DatasetSchema): JsonObject {
	return {
		contract: schema.contract,
		name: schema.name,
		version: schema.version,
		keyFields: [...schema.keyFields],
		fields: schema.fields.map((field) => ({
			name: field.name,
			type: field.type,
			nullable: field.nullable,
		})),
		open: schema.open,
	};
}

/** Stable digest of a schema — what a plan pins and a drift check compares. */
export function schemaDigest(schema: DatasetSchema): `sha256:${string}` {
	return `sha256:${sha256Hex(canonicalEncode(schemaToJson(schema)))}`;
}

function normalizeInt64(value: JsonValue, field: string): string {
	let text: string;
	if (isJsonNumber(value)) {
		if (!Number.isSafeInteger(value)) {
			invalidRecord(
				"int64 given as a JSON number must be a safe integer; pass a decimal string beyond 2^53",
				field,
			);
		}
		text = String(value);
	} else if (isJsonString(value) && INT64_PATTERN.test(value)) {
		text = value;
	} else {
		return invalidRecord("int64 must be an integer or a decimal string", field);
	}
	const parsed = BigInt(text);
	if (parsed < INT64_MIN || parsed > INT64_MAX) {
		invalidRecord("int64 is out of range", field);
	}
	return parsed.toString();
}

function normalizeDecimal(value: JsonValue, field: string): string {
	if (!isJsonString(value) || !DECIMAL_PATTERN.test(value)) {
		return invalidRecord(
			"decimal must be a plain decimal string such as -12.50",
			field,
		);
	}
	const text: string = value;
	const negative = text.startsWith("-");
	const unsigned = negative ? text.slice(1) : text;
	const [wholeRaw = "0", fractionRaw = ""] = unsigned.split(".");
	const whole = wholeRaw.replace(/^0+(?=[0-9])/u, "");
	const fraction = fractionRaw.replace(/0+$/u, "");
	const magnitude = fraction === "" ? whole : `${whole}.${fraction}`;
	return negative && magnitude !== "0" ? `-${magnitude}` : magnitude;
}

function normalizeBytes(value: JsonValue, field: string): string {
	if (!isJsonString(value) || !BASE64_PATTERN.test(value)) {
		return invalidRecord("bytes must be standard padded base64", field);
	}
	return Buffer.from(value, "base64").toString("base64");
}

function pad(value: number, width: number): string {
	return String(value).padStart(width, "0");
}

/**
 * Milliseconds since the epoch for a UTC civil time. `Date.UTC` cannot be used
 * directly: it maps years 0–99 onto 1900–1999, which would silently move a
 * first-century date nineteen centuries — exactly the alteration this model
 * exists to prevent.
 */
function utcMillis(
	year: number,
	month: number,
	day: number,
	hour = 0,
	minute = 0,
	second = 0,
): number {
	const instant = new Date(0);
	instant.setUTCFullYear(year, month - 1, day);
	instant.setUTCHours(hour, minute, second, 0);
	return instant.getTime();
}

function normalizeDate(value: JsonValue, field: string): string {
	const match = isJsonString(value) ? DATE_PATTERN.exec(value) : null;
	if (match === null) return invalidRecord("date must be YYYY-MM-DD", field);
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const probe = new Date(utcMillis(year, month, day));
	if (
		probe.getUTCFullYear() !== year ||
		probe.getUTCMonth() !== month - 1 ||
		probe.getUTCDate() !== day
	) {
		invalidRecord("date is not a real calendar date", field);
	}
	return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/**
 * RFC 3339 → UTC with exactly six fractional digits.
 *
 * Microseconds is the canonical precision because it is the finest every
 * relational engine here stores exactly. Nanosecond digits are accepted only
 * when they are zero: silently truncating them would be data loss wearing a
 * normalisation label.
 */
function normalizeTimestamp(value: JsonValue, field: string): string {
	const match = isJsonString(value) ? TIMESTAMP_PATTERN.exec(value) : null;
	if (match === null) {
		return invalidRecord(
			"timestamp must be RFC 3339 with an explicit offset",
			field,
		);
	}
	const fractionDigits = (match[7] ?? "").padEnd(9, "0");
	if (fractionDigits.slice(6) !== "000") {
		invalidRecord(
			"timestamp precision beyond microseconds is not representable",
			field,
		);
	}
	const micros = fractionDigits.slice(0, 6);
	const offsetText = match[8] ?? "Z";
	let offsetMinutes = 0;
	if (offsetText !== "Z" && offsetText !== "z") {
		const sign = offsetText.startsWith("-") ? -1 : 1;
		const digits = offsetText.slice(1).replace(":", "");
		offsetMinutes =
			sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
	}
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	// The civil fields must name a real instant before any offset is applied:
	// `Date` would otherwise roll 25:61 or February 30th into the next day.
	const local = new Date(utcMillis(year, month, day, hour, minute, second));
	if (
		local.getUTCFullYear() !== year ||
		local.getUTCMonth() !== month - 1 ||
		local.getUTCDate() !== day ||
		local.getUTCHours() !== hour ||
		local.getUTCMinutes() !== minute ||
		local.getUTCSeconds() !== second
	) {
		invalidRecord("timestamp is not a real instant", field);
	}
	const wholeSeconds = local.getTime() - offsetMinutes * 60_000;
	const utc = new Date(wholeSeconds);
	if (utc.getUTCFullYear() < 0 || utc.getUTCFullYear() > 9999) {
		invalidRecord("timestamp is outside years 0000-9999 in UTC", field);
	}
	return (
		`${pad(utc.getUTCFullYear(), 4)}-${pad(utc.getUTCMonth() + 1, 2)}-${pad(utc.getUTCDate(), 2)}` +
		`T${pad(utc.getUTCHours(), 2)}:${pad(utc.getUTCMinutes(), 2)}:${pad(utc.getUTCSeconds(), 2)}.${micros}Z`
	);
}

/**
 * An encrypted value is opaque by contract (ADR-0177 decision 9): it moves as
 * ciphertext, so destroying the forgetting key erases every copy at once and
 * no engine, relay, or artifact ever needs the key.
 */
function normalizeEncrypted(value: JsonValue, field: string): JsonObject {
	if (!isJsonObject(value)) {
		return invalidRecord(
			"encrypted value must be { alg, keyRef, ciphertext }",
			field,
		);
	}
	const { alg, keyRef, ciphertext } = value;
	if (!isJsonString(alg) || alg === "") {
		invalidRecord("encrypted.alg must be a non-empty string", field);
	}
	if (!isJsonString(keyRef) || keyRef === "") {
		invalidRecord("encrypted.keyRef must be a non-empty locator", field);
	}
	return {
		alg: wellFormed(alg, field),
		keyRef: wellFormed(keyRef, field),
		ciphertext: normalizeBytes(ciphertext ?? null, `${field}.ciphertext`),
	};
}

/**
 * A lone surrogate has no UTF-8 encoding. Every engine and every digest would
 * replace it with U+FFFD, so two different strings would store and hash the
 * same. The canonical model refuses it once, here, for every engine.
 */
function wellFormed(value: string, field: string): string {
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit < 0xd800 || unit > 0xdfff) continue;
		const next = value.charCodeAt(index + 1);
		// A high surrogate must be followed by a low one; a low one alone is lone.
		if (unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
			index += 1;
			continue;
		}
		invalidRecord("string contains an unpaired surrogate", field);
	}
	return value;
}

function wellFormedJson(value: JsonValue, field: string): JsonValue {
	if (isJsonString(value)) return wellFormed(value, field);
	if (isJsonArray(value)) {
		for (const item of value) wellFormedJson(item, field);
	} else if (isJsonObject(value)) {
		for (const key of Object.keys(value)) {
			wellFormed(key, field);
			wellFormedJson(value[key] ?? null, field);
		}
	}
	return value;
}

/** Normalise one value to the single canonical form its type allows. */
export function normalizeCanonicalValue(
	type: CanonicalType,
	value: JsonValue,
	field: string,
): JsonValue {
	switch (type) {
		case "bool":
			return isJsonBoolean(value)
				? value
				: invalidRecord("bool must be true or false", field);
		case "int64":
			return normalizeInt64(value, field);
		case "float64":
			return isJsonNumber(value) && Number.isFinite(value)
				? value
				: invalidRecord("float64 must be a finite number", field);
		case "decimal":
			return normalizeDecimal(value, field);
		case "string":
			return isJsonString(value)
				? wellFormed(value, field)
				: invalidRecord("string must be a string", field);
		case "bytes":
			return normalizeBytes(value, field);
		case "timestamp":
			return normalizeTimestamp(value, field);
		case "date":
			return normalizeDate(value, field);
		case "uuid":
			return isJsonString(value) && UUID_PATTERN.test(value)
				? value.toLowerCase()
				: invalidRecord("uuid must be 8-4-4-4-12 hexadecimal", field);
		case "json":
			return wellFormedJson(value, field);
		case "encrypted":
			return normalizeEncrypted(value, field);
	}
}

/**
 * The one constructor for a canonical record. Every field is present in the
 * result (absent nullable fields become `null`) so two records that differ
 * only in whether a null was written compare equal.
 */
export function parseCanonicalRecord(
	schema: DatasetSchema,
	value: JsonValue | undefined,
): CanonicalRecord {
	if (!isJsonObject(value)) invalidRecord("record must be an object", "record");
	// Entries, not property assignment: assigning a key named `__proto__`
	// sets the prototype and silently drops the field.
	const entries: [string, JsonValue][] = [];
	const declared = new Set<string>();
	for (const field of schema.fields) {
		declared.add(field.name);
		const raw = value[field.name];
		if (raw === undefined || raw === null) {
			if (!field.nullable) {
				invalidRecord(`${field.name} is required`, field.name);
			}
			entries.push([field.name, null]);
			continue;
		}
		entries.push([
			field.name,
			normalizeCanonicalValue(field.type, raw, field.name),
		]);
	}
	for (const key of Object.keys(value)) {
		if (declared.has(key)) continue;
		if (!schema.open) {
			invalidRecord(`${key} is not declared by schema ${schema.name}`, key);
		}
		wellFormed(key, key);
		entries.push([key, wellFormedJson(value[key] ?? null, key)]);
	}
	return freezeDeep(Object.fromEntries(entries));
}

/**
 * The canonical key of a record: the canonical encoding of its key-field
 * values in declared order. A string, so it orders and hashes the same way in
 * every engine and crosses every port unchanged.
 */
export function encodeRecordKey(
	schema: DatasetSchema,
	record: CanonicalRecord,
): string {
	return canonicalEncode(schema.keyFields.map((name) => record[name] ?? null));
}

/** Inverse of `encodeRecordKey`: the key-field values, by field name. */
export function decodeRecordKey(
	schema: DatasetSchema,
	key: string,
): CanonicalRecord {
	let parsed: JsonValue;
	try {
		// SAFETY: JSON.parse yields a JSON value at this document boundary.
		parsed = JSON.parse(key) as JsonValue;
	} catch (cause) {
		throw new DataCoreError("INVALID_RECORD", "key is not canonical JSON", {
			cause,
			detail: { field: "key" },
		});
	}
	if (!isJsonArray(parsed) || parsed.length !== schema.keyFields.length) {
		invalidRecord("key does not match the schema's key fields", "key");
	}
	const result: { [key: string]: JsonValue } = {};
	schema.keyFields.forEach((name, index) => {
		const field = schema.fields.find((entry) => entry.name === name);
		const raw = parsed[index] ?? null;
		result[name] =
			field === undefined
				? raw
				: normalizeCanonicalValue(field.type, raw, name);
	});
	return freezeDeep(result);
}

/**
 * Digest of one record in a scope. The tenant and key participate so a record
 * that moved between keys or tenants never digests equal to the original.
 */
export function recordDigest(
	tenant: string,
	key: string,
	record: CanonicalRecord,
): string {
	return sha256Hex(canonicalEncode([tenant, key, record]));
}
