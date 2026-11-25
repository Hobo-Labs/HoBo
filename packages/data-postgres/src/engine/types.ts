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

export function parameterExpression(
	type: CanonicalType,
	index: number,
): string {
	return type === "bytes"
		? `decode($${index}::text, 'hex')`
		: `$${index}::${POSTGRES_NATIVE_TYPES[type]}`;
}

export function assertStorableText(value: string, field: string): void {
	if (value.includes("\u0000")) {
		refuse("text cannot hold U+0000", field);
	}
	if (/\p{Surrogate}/u.test(value)) {
		refuse("text cannot hold an unpaired surrogate", field);
	}
}

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

export type NativeTextSource = "select" | "decoded";

export function selectExpression(type: CanonicalType, column: string): string {
	const quoted = quoteIdentifier(column);
	switch (type) {
		case "float64":
			return `encode(float8send(${quoted}), 'hex')`;
		case "bytes":
			return `encode(${quoted}, 'hex')`;
		case "timestamp":
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
		parsed = JSON.parse(text) as JsonValue;
	} catch (cause) {
		throw new DataCoreError("INVALID_RECORD", "stored JSON does not parse", {
			cause,
			detail: { field },
		});
	}
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
		refuse("float64 is not a finite number", field);
	}
	return Number(text);
}

function timestampFrom(text: string, field: string): string {
	const match = TIMESTAMP_TEXT.exec(text);
	if (match === null) {
		return refuse("timestamp is outside the canonical range", field);
	}
	const [, year, month, day, hour, minute, second, fraction = ""] = match;
	return `${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction.padEnd(6, "0")}Z`;
}

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
			return text;
	}
}

export type NativeCell = string | null | undefined;

export function canonicalFromNative(
	schema: DatasetSchema,
	cell: (column: string) => NativeCell,
	source: NativeTextSource,
): CanonicalRecord {
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

export function openFieldsOf(
	schema: DatasetSchema,
	record: CanonicalRecord,
): JsonObject {
	const declared = new Set(schema.fields.map((field) => field.name));
	return Object.fromEntries(
		Object.entries(record).filter(([name]) => !declared.has(name)),
	);
}

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

export function keyFieldsOf(schema: DatasetSchema): readonly DatasetField[] {
	return schema.keyFields.map((name) => fieldOf(schema, name));
}

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
	const collation = key && field.type === "string" ? ' COLLATE "C"' : "";
	const nullability = field.nullable ? "" : " NOT NULL";
	return `${quoteIdentifier(field.name)} ${POSTGRES_NATIVE_TYPES[field.type]}${collation}${nullability}`;
}

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
