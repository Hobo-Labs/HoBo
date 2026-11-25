/**
 * The PostgreSQL type-mapping annex, and the two conversions that realise it.
 *
 * Canonical → native goes out as a text parameter the statement casts.
 * Native → canonical comes back as text in one of two dialects: the
 * session-independent expressions this module selects with, and the text
 * tuples logical decoding emits under the settings the capture port pins.
 * Both dialects are parsed strictly here and then normalised through
 * `parseCanonicalRecord`, so a value that reads back is byte-identical to the
 * value that was written — or the read fails. It is never altered.
 */
import {
	type CanonicalRecord,
	type CanonicalType,
	DataCoreError,
	type DatasetField,
	type DatasetSchema,
	type JsonObject,
	type JsonValue,
	parseCanonicalRecord,
} from "@hobo/data-core";
import { isPlainObject, isText } from "./guards.js";
import {
	OPEN_FIELDS_COLUMN,
	qualifiedName,
	quoteIdentifier,
	TENANT_COLUMN,
} from "./identifiers.js";

// public-contract: engine id reported in the PostgreSQL engine declaration.
export const POSTGRES_ENGINE_ID = "postgres";

/** The native column type each canonical type is stored in. */
export const POSTGRES_NATIVE_TYPES = Object.freeze({
	bool: "boolean",
	int64: "bigint",
	float64: "double precision",
	decimal: "numeric",
	string: "text",
	bytes: "bytea",
	timestamp: "timestamptz",
	date: "date",
	uuid: "uuid",
	json: "jsonb",
	encrypted: "jsonb",
} as const satisfies Readonly<Record<CanonicalType, string>>);

const NATIVE_RANGE_NOTE =
	"a natively written NaN or infinity has no canonical form and is refused on read, never altered";

/** How each canonical type lands in PostgreSQL, and how faithful the trip is. */
export const POSTGRES_TYPE_MAPPING: JsonObject = Object.freeze({
	engine: POSTGRES_ENGINE_ID,
	edges: [
		{
			canonical: "bool",
			native: "boolean",
			write: "exact",
			read: "exact",
			note: "",
		},
		{
			canonical: "int64",
			native: "bigint",
			write: "exact",
			read: "exact",
			note: "",
		},
		{
			canonical: "float64",
			native: "double precision",
			write: "exact",
			read: "widening",
			note: NATIVE_RANGE_NOTE,
		},
		{
			canonical: "decimal",
			native: "numeric",
			write: "constrained",
			read: "widening",
			note: `unconstrained numeric holds up to 131072 digits before and 16383 after the decimal point, and the server refuses a value beyond that; ${NATIVE_RANGE_NOTE}`,
		},
		{
			canonical: "string",
			native: "text",
			write: "constrained",
			read: "exact",
			note: "text cannot hold U+0000 or an unpaired surrogate; a string containing either is refused at write, never stored altered",
		},
		{
			canonical: "bytes",
			native: "bytea",
			write: "exact",
			read: "exact",
			note: "",
		},
		{
			canonical: "timestamp",
			native: "timestamptz",
			write: "constrained",
			read: "widening",
			note: "microsecond-exact for years 0001-9999; the server has no year 0000 and refuses it at write (an instant whose UTC form falls in year 0000 included), and a natively written BC instant, one past year 9999, or an infinity is refused on read, never altered",
		},
		{
			canonical: "date",
			native: "date",
			write: "constrained",
			read: "widening",
			note: "exact for years 0001-9999; the server has no year 0000 and refuses it at write, and a natively written BC date, one past year 9999, or an infinity is refused on read, never altered",
		},
		{
			canonical: "uuid",
			native: "uuid",
			write: "exact",
			read: "exact",
			note: "",
		},
		{
			canonical: "json",
			native: "jsonb",
			write: "constrained",
			read: "widening",
			note: "jsonb refuses U+0000 inside a string at write; it keeps numbers at arbitrary precision, so a natively written number float64 cannot hold exactly reads as the nearest float64, and one beyond float64's range is refused on read, never altered",
		},
		{
			canonical: "encrypted",
			native: "jsonb",
			write: "constrained",
			read: "widening",
			note: "stored as an opaque jsonb envelope { alg, keyRef, ciphertext }; jsonb refuses U+0000 inside alg or keyRef at write, and a natively written value of another form is refused on read",
		},
	],
});

function refuse(message: string, field: string): never {
	throw new DataCoreError("INVALID_RECORD", message, { detail: { field } });
}

// ── canonical → native ──────────────────────────────────────────────────────

/** The cast applied to parameter `$index` for a column of `type`. */
export function parameterExpression(
	type: CanonicalType,
	index: number,
): string {
	return type === "bytes"
		? `decode($${index}::text, 'hex')`
		: `$${index}::${POSTGRES_NATIVE_TYPES[type]}`;
}

/**
 * A string the server would store as something else is refused here. U+0000
 * the server refuses itself; an unpaired surrogate it never sees, because
 * UTF-8 encoding replaces it with U+FFFD on the way out — a silent alteration
 * that has to be stopped before the driver.
 */
export function assertStorableText(value: string, field: string): void {
	if (value.includes("\u0000")) {
		refuse("text cannot hold U+0000", field);
	}
	if (/\p{Surrogate}/u.test(value)) {
		refuse("text cannot hold an unpaired surrogate", field);
	}
}

/** Encode one canonical (already normalised) value as a text parameter. */
export function encodeParameter(
	type: CanonicalType,
	value: JsonValue,
	field: string,
): string | null {
	if (value === null) return null;
	switch (type) {
		case "bool":
			return value === true ? "true" : "false";
		case "float64":
			// The shortest text that round-trips the double; the server parses
			// it back to the same bits.
			return String(value);
		case "bytes":
			return Buffer.from(String(value), "base64").toString("hex");
		case "json":
		case "encrypted":
			return JSON.stringify(value);
		case "string": {
			const text = String(value);
			assertStorableText(text, field);
			return text;
		}
		default:
			return String(value);
	}
}

// ── native → canonical ──────────────────────────────────────────────────────

/**
 * Where native text came from. `select` is this module's own expressions,
 * which do not depend on session settings; `decoded` is a logical-decoding
 * text tuple, produced by the type output functions under the settings the
 * capture port pins (UTC, ISO dates, hex bytea, shortest floats).
 */
export type NativeTextSource = "select" | "decoded";

/** The select-list expression that yields `column` as text. */
export function selectExpression(type: CanonicalType, column: string): string {
	const quoted = quoteIdentifier(column);
	switch (type) {
		case "float64":
			// The eight IEEE-754 bytes, so no float formatting setting applies.
			return `encode(float8send(${quoted}), 'hex')`;
		case "bytes":
			return `encode(${quoted}, 'hex')`;
		case "timestamp":
			// JSON output is ISO 8601 whatever the session's DateStyle, and
			// spells out BC and infinity instead of dropping them.
			return `to_json(${quoted} AT TIME ZONE 'UTC') #>> '{}'`;
		case "date":
			return `to_json(${quoted}) #>> '{}'`;
		case "string":
			return quoted;
		default:
			return `${quoted}::text`;
	}
}

const FLOAT_TEXT = /^-?(?:[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)$/u;
const HEX_BYTES = /^(?:[0-9a-fA-F]{2})*$/u;
const TIMESTAMP_TEXT =
	/^([0-9]{4})-([0-9]{2})-([0-9]{2})[T ]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?(?:\+00(?::?00)?)?$/u;

/** True when every number in a parsed document is one JSON can carry. */
function everyNumberFinite(value: JsonValue): boolean {
	if (Array.isArray(value)) return value.every(everyNumberFinite);
	if (isPlainObject(value)) {
		return Object.values(value).every(everyNumberFinite);
	}
	return !Number.isNaN(value) && value !== Infinity && value !== -Infinity;
}

function parseJson(text: string, field: string): JsonValue {
	let parsed: JsonValue;
	try {
		// SAFETY: JSON.parse yields a JSON value at this document boundary.
		parsed = JSON.parse(text) as JsonValue;
	} catch (cause) {
		throw new DataCoreError("INVALID_RECORD", "stored JSON does not parse", {
			cause,
			detail: { field },
		});
	}
	// `jsonb` keeps numbers at arbitrary precision. One beyond float64's range
	// (a natively written 1e400) parses to an infinity, which canonical JSON
	// has no form for — it would be written back as `null`. Refused instead.
	if (!everyNumberFinite(parsed)) {
		refuse("stored JSON holds a number beyond float64's range", field);
	}
	return parsed;
}

function float64From(
	text: string,
	source: NativeTextSource,
	field: string,
): number {
	if (source === "select") {
		if (text.length !== 16 || !HEX_BYTES.test(text)) {
			refuse("float64 did not arrive as eight bytes", field);
		}
		return Buffer.from(text, "hex").readDoubleBE(0);
	}
	if (!FLOAT_TEXT.test(text)) {
		// NaN and the infinities land here: they have no canonical form.
		refuse("float64 is not a finite number", field);
	}
	return Number(text);
}

function timestampFrom(text: string, field: string): string {
	const match = TIMESTAMP_TEXT.exec(text);
	if (match === null) {
		// BC instants, years past 9999, the infinities, and any non-UTC text.
		return refuse("timestamp is outside the canonical range", field);
	}
	// Years 0001–0099 pass through like any other: the pattern holds every
	// year to four digits, and the canonical normaliser reads them as written.
	// (The server has no year 0000, so it never sends one.)
	const [, year, month, day, hour, minute, second, fraction = ""] = match;
	return `${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction.padEnd(6, "0")}Z`;
}

/** Convert one native text value to the raw value `parseCanonicalRecord` takes. */
export function nativeTextToCanonical(
	type: CanonicalType,
	text: string,
	source: NativeTextSource,
	field: string,
): JsonValue {
	switch (type) {
		case "bool":
			if (text === "true" || text === "t") return true;
			if (text === "false" || text === "f") return false;
			return refuse("bool is neither true nor false", field);
		case "float64":
			return float64From(text, source, field);
		case "bytes": {
			const hex = text.startsWith("\\x") ? text.slice(2) : text;
			if (!HEX_BYTES.test(hex)) refuse("bytes did not arrive as hex", field);
			return Buffer.from(hex, "hex").toString("base64");
		}
		case "timestamp":
			return timestampFrom(text, field);
		case "json":
		case "encrypted":
			return parseJson(text, field);
		default:
			// int64, decimal, string, date, uuid: already in a form the
			// canonical normaliser accepts or refuses on its own.
			return text;
	}
}

/** The native value of one column: text, SQL NULL, or not supplied at all. */
export type NativeCell = string | null | undefined;

/**
 * Build the canonical record for one row. `cell` answers a column name with
 * its native text, `null` for SQL NULL, or `undefined` when the row does not
 * carry the column.
 */
export function canonicalFromNative(
	schema: DatasetSchema,
	cell: (column: string) => NativeCell,
	source: NativeTextSource,
): CanonicalRecord {
	// Entries, not property assignment: assigning a key named `__proto__`
	// sets the prototype and silently drops the field. Declared fields come
	// last, so a stray overflow member can never shadow a typed column.
	const entries: [string, JsonValue][] = [];
	if (schema.open) {
		const extra = cell(OPEN_FIELDS_COLUMN);
		if (isText(extra)) {
			const parsed = parseJson(extra, OPEN_FIELDS_COLUMN);
			if (isPlainObject(parsed)) entries.push(...Object.entries(parsed));
		}
	}
	for (const field of schema.fields) {
		const text = cell(field.name);
		entries.push([
			field.name,
			text === null || text === undefined
				? null
				: nativeTextToCanonical(field.type, text, source, field.name),
		]);
	}
	return parseCanonicalRecord(schema, Object.fromEntries(entries));
}

/** The undeclared fields of an open-schema record, as the overflow object. */
export function openFieldsOf(
	schema: DatasetSchema,
	record: CanonicalRecord,
): JsonObject {
	const declared = new Set(schema.fields.map((field) => field.name));
	// Built from entries: `extra.__proto__ = value` would set a prototype and
	// the field would never reach the overflow column.
	return Object.fromEntries(
		Object.entries(record).filter(([name]) => !declared.has(name)),
	);
}

// ── DDL ─────────────────────────────────────────────────────────────────────

function fieldOf(schema: DatasetSchema, name: string): DatasetField {
	const field = schema.fields.find((entry) => entry.name === name);
	if (field === undefined) {
		throw new DataCoreError(
			"INVALID_DATASET_SCHEMA",
			`key field ${name} is not declared`,
			{ detail: { field: name } },
		);
	}
	return field;
}

/** The key fields of a schema, in declared key order. */
export function keyFieldsOf(schema: DatasetSchema): readonly DatasetField[] {
	return schema.keyFields.map((name) => fieldOf(schema, name));
}

/**
 * Names a dataset field may not take, because the table needs them. Refused
 * at `ensureDataset`, where the caller can still rename, rather than at the
 * first write.
 */
export function assertNoReservedColumns(schema: DatasetSchema): void {
	for (const field of schema.fields) {
		if (field.name === TENANT_COLUMN || field.name === OPEN_FIELDS_COLUMN) {
			throw new DataCoreError(
				"INVALID_DATASET_SCHEMA",
				`field name ${field.name} is reserved by the PostgreSQL binding`,
				{ detail: { dataset: schema.name, field: field.name } },
			);
		}
	}
}

function columnDefinition(field: DatasetField, key: boolean): string {
	// Key text sorts by byte, not by locale: a locale collation can change
	// under an operating-system upgrade and silently corrupt a primary key.
	const collation = key && field.type === "string" ? ' COLLATE "C"' : "";
	const nullability = field.nullable ? "" : " NOT NULL";
	return `${quoteIdentifier(field.name)} ${POSTGRES_NATIVE_TYPES[field.type]}${collation}${nullability}`;
}

/**
 * `CREATE TABLE` for a dataset: the tenant column, one typed column per
 * field, an overflow column when the schema is open, and a primary key of
 * tenant plus the key fields. Pure — the same schema always emits the same
 * statement.
 */
export function datasetTableDdl(
	namespace: string,
	schema: DatasetSchema,
): string {
	assertNoReservedColumns(schema);
	const columns = [
		`${quoteIdentifier(TENANT_COLUMN)} text COLLATE "C" NOT NULL DEFAULT ''`,
		...schema.fields.map((field) =>
			columnDefinition(field, schema.keyFields.includes(field.name)),
		),
		...(schema.open
			? [
					`${quoteIdentifier(OPEN_FIELDS_COLUMN)} jsonb NOT NULL DEFAULT '{}'::jsonb`,
				]
			: []),
		`PRIMARY KEY (${[TENANT_COLUMN, ...schema.keyFields].map(quoteIdentifier).join(", ")})`,
	];
	return `CREATE TABLE ${qualifiedName(namespace, schema.name)} (\n\t${columns.join(",\n\t")}\n)`;
}
