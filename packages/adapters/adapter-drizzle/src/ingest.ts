/**
 * Ingestion: a Drizzle schema module in, the canonical HoBo schema IR out.
 *
 * This is the parse boundary of the package. It takes an untrusted bag of
 * module exports and returns a derived type — `SchemaIr` as parsed by
 * `@hobo/core` — plus the impedance findings that say what could not be
 * carried across. HoBo owns the IR; Drizzle is an authoring surface, not the
 * source of truth (ADR-0160).
 *
 * Determinism is a hard requirement: the same module ingested twice must be
 * deep-equal including ordering, because the plan digest downstream is a hash
 * over this output. Every collection is therefore sorted by name, and export
 * keys are walked in sorted order so that "first one wins" tie-breaks do not
 * depend on module authoring order.
 */

import {
	parseSchemaIr,
	SCHEMA_IR_CONTRACT,
	type SchemaColumn,
	type SchemaIndex,
	type SchemaIr,
	type SchemaTable,
} from "@hobo/core";
import { DrizzleAdapterError } from "./errors.js";
import { type DrizzleImpedanceFinding, sortImpedance } from "./impedance.js";
import {
	cloneAsJson,
	isJsonBigInt,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";
import { compareText } from "./order.js";
import {
	asRecord,
	type DrizzleColumnLike,
	type DrizzleIndexLike,
	extraConfigBuilder,
	extraConfigColumns,
	hasInlineForeignKeys,
	isDrizzleColumn,
	isDrizzleTable,
	isDrizzleView,
	isNonPostgresColumn,
	readColumnSqlType,
	readIndexBuilder,
	tableColumns,
	tableName,
	tableSchema,
	type UnknownRecord,
} from "./shape.js";

export interface DrizzleIngestOptions {
	readonly dialect?: "postgres";
}

export interface DrizzleIngestResult {
	readonly schema: SchemaIr;
	readonly impedance: readonly DrizzleImpedanceFinding[];
}

/**
 * Structural ingestion of a Drizzle schema module's exported table objects.
 * Unrecognized constructs are collected as impedance findings, never silently
 * dropped and never thrown over.
 */
export function ingestDrizzleSchema<SchemaModule>(
	moduleExports: SchemaModule,
	options?: DrizzleIngestOptions,
): DrizzleIngestResult {
	if (!isSchemaModule(moduleExports)) {
		throw new DrizzleAdapterError(
			"DRIZZLE_INGEST_INPUT_INVALID",
			"ingestDrizzleSchema expects a module namespace object of exports.",
			'Pass the result of `import * as schema from "./schema.js"` (or an equivalent record of exports).',
		);
	}
	const dialect = options?.dialect ?? "postgres";
	if (dialect !== "postgres") {
		throw new DrizzleAdapterError(
			"DRIZZLE_DIALECT_UNSUPPORTED",
			`Dialect "${String(dialect)}" is not supported by this adapter.`,
			'Ingest a postgres Drizzle schema, or omit `dialect` to accept the "postgres" default.',
		);
	}

	const findings: DrizzleImpedanceFinding[] = [];
	const tablesByName = new Map<string, SchemaTable>();
	const exportKeyByTableName = new Map<string, string>();

	for (const exportKey of Object.keys(moduleExports).sort()) {
		const value = moduleExports[exportKey];
		if (isDrizzleView(value)) {
			findings.push({
				code: "DRIZZLE_VIEW_UNREAD",
				detail: `Export "${exportKey}" is a Drizzle view; the canonical schema IR models tables only.`,
			});
			continue;
		}
		if (!isDrizzleTable(value)) {
			findings.push({
				code: "DRIZZLE_EXPORT_UNRECOGNIZED",
				detail: `Export "${exportKey}" (${describe(value)}) is not a Drizzle table and was not ingested.`,
			});
			continue;
		}
		const table = readTable(exportKey, value, findings);
		if (table === undefined) continue;
		const previousKey = exportKeyByTableName.get(table.name);
		if (previousKey !== undefined) {
			findings.push({
				code: "DRIZZLE_TABLE_NAME_DUPLICATE",
				detail: `Exports "${previousKey}" and "${exportKey}" both declare table "${table.name}"; the first by export name was kept.`,
			});
			continue;
		}
		exportKeyByTableName.set(table.name, exportKey);
		tablesByName.set(table.name, table);
	}

	const tables = [...tablesByName.values()].sort((left, right) =>
		compareText(left.name, right.name),
	);
	const schema = parseSchemaIr(
		cloneAsJson({
			contract: SCHEMA_IR_CONTRACT,
			dialect: "postgres",
			tables,
		}),
	);

	return Object.freeze({
		schema,
		impedance: sortImpedance(findings),
	});
}

/**
 * A schema module arrives either as a plain record of exports or as the module
 * namespace object `import * as schema` produces. The namespace is an exotic
 * object tagged `Module`, not `Object`, so it has to be admitted by name or the
 * documented way of calling this function is the one way that is refused.
 */
function isSchemaModule<T>(value: T): value is T & JsonObject {
	if (value === undefined || value === null) return false;
	if (isJsonObject(value)) return true;
	return Object.prototype.toString.call(value) === "[object Module]";
}

function readTable<T>(
	exportKey: string,
	table: T,
	findings: DrizzleImpedanceFinding[],
): SchemaTable | undefined {
	const name = tableName(table);
	const schema = tableSchema(table);
	if (schema !== undefined) {
		findings.push({
			code: "DRIZZLE_TABLE_SCHEMA_UNREPRESENTABLE",
			detail: `Table "${name}" is bound to postgres schema "${schema}"; the canonical IR has no schema qualifier and treats it as unqualified.`,
		});
	}
	if (hasInlineForeignKeys(table)) {
		findings.push({
			code: "DRIZZLE_FOREIGN_KEY_UNREAD",
			detail: `Table "${name}" declares inline foreign keys; the canonical IR has no foreign-key concept, so referential constraints are not diffed.`,
		});
	}

	const columns = readColumns(name, tableColumns(table), findings);
	if (columns.length === 0) {
		findings.push({
			code: "DRIZZLE_TABLE_COLUMNS_EMPTY",
			detail: `Export "${exportKey}" is table-shaped but yielded no readable columns, so no table was emitted for "${name}".`,
		});
		return undefined;
	}

	return Object.freeze({
		name,
		columns: Object.freeze(columns),
		indexes: Object.freeze(readIndexes(name, table, findings)),
	});
}

function readColumns(
	table: string,
	columnMap: UnknownRecord,
	findings: DrizzleImpedanceFinding[],
): SchemaColumn[] {
	const columns: SchemaColumn[] = [];
	for (const propertyName of Object.keys(columnMap).sort()) {
		const value = columnMap[propertyName];
		if (!isDrizzleColumn(value)) {
			findings.push({
				code: "DRIZZLE_COLUMN_UNRECOGNIZED",
				detail: `Property "${propertyName}" of table "${table}" (${describe(value)}) is not a readable column descriptor.`,
			});
			continue;
		}
		if (isNonPostgresColumn(value)) {
			findings.push({
				code: "DRIZZLE_NON_POSTGRES_TABLE",
				detail: `Column "${value.name}" of table "${table}" has dialect-specific type "${String(value.columnType)}"; this adapter ingests postgres only.`,
			});
			continue;
		}
		const type = readColumnSqlType(value);
		if (type === undefined) {
			findings.push({
				code: "DRIZZLE_COLUMN_TYPE_UNREADABLE",
				detail: `Column "${value.name}" of table "${table}" exposed no readable SQL type.`,
			});
			continue;
		}
		columns.push(readColumn(table, value, type, findings));
	}
	return columns.sort((left, right) => compareText(left.name, right.name));
}

function readColumn(
	table: string,
	column: DrizzleColumnLike,
	type: string,
	findings: DrizzleImpedanceFinding[],
): SchemaColumn {
	const primaryKey = column.primary === true;
	const defaultExpression = readDefault(table, column, findings);
	return Object.freeze({
		name: column.name,
		type,
		// A primary key is not nullable even when the descriptor omits notNull.
		nullable: column.notNull !== true && !primaryKey,
		primaryKey,
		unique: column.isUnique === true,
		...(defaultExpression !== undefined ? { defaultExpression } : undefined),
	});
}

/**
 * Only literal defaults survive into the IR. A SQL expression object or a
 * runtime `defaultFn` is Drizzle-side behavior the IR cannot reproduce, so it
 * becomes a finding instead of a guessed expression string.
 */
function readDefault(
	table: string,
	column: DrizzleColumnLike,
	findings: DrizzleImpedanceFinding[],
): string | undefined {
	const hasDefault = column.hasDefault === true || column.default !== undefined;
	if (!hasDefault) return undefined;
	if (column.defaultFn instanceof Function) {
		findings.push({
			code: "DRIZZLE_DEFAULT_UNREPRESENTABLE",
			detail: `Column "${column.name}" of table "${table}" has a runtime default function; it is applied by Drizzle at insert time and is not part of the schema.`,
		});
		return undefined;
	}
	const value = column.default;
	if (isJsonString(value)) return `'${value.replace(/'/gu, "''")}'`;
	if (isJsonNumber(value) || isJsonBigInt(value)) {
		return String(value);
	}
	if (isJsonBoolean(value)) return value ? "true" : "false";
	if (value === null) return "null";
	findings.push({
		code: "DRIZZLE_DEFAULT_UNREPRESENTABLE",
		detail: `Column "${column.name}" of table "${table}" has a non-literal default (${describe(value)}); it is not carried into the canonical IR.`,
	});
	return undefined;
}

/**
 * Indexes live in a table's extra-config callback rather than on the table
 * object, so reading them means invoking that callback with the table's
 * extra-config columns. The call is guarded: third-party code that throws, or
 * returns builders this adapter cannot read, produces a finding rather than a
 * crash or a silently index-free table.
 */
function readIndexes<T>(
	table: string,
	tableValue: T,
	findings: DrizzleImpedanceFinding[],
): SchemaIndex[] {
	const builder = extraConfigBuilder(tableValue);
	if (builder === undefined) return [];

	let produced: JsonValue;
	try {
		produced = builder(extraConfigColumns(tableValue));
	} catch (cause) {
		findings.push({
			code: "DRIZZLE_EXTRA_CONFIG_UNREAD",
			detail: `Table "${table}" has an extra-config callback that threw when read (${describe(cause)}); indexes and constraints declared there were not ingested.`,
		});
		return [];
	}

	const entries = extraConfigEntries(produced);
	if (entries === undefined) {
		findings.push({
			code: "DRIZZLE_EXTRA_CONFIG_UNREAD",
			detail: `Table "${table}" has an extra-config callback returning ${describe(produced)}; only arrays and records of index builders are readable.`,
		});
		return [];
	}

	const indexes: SchemaIndex[] = [];
	for (const [entryKey, entryValue] of entries) {
		const read: DrizzleIndexLike | undefined = readIndexBuilder(entryValue);
		if (read === undefined) {
			findings.push({
				code: "DRIZZLE_EXTRA_CONFIG_UNREAD",
				detail: `Extra-config entry "${entryKey}" of table "${table}" (${describe(entryValue)}) is not a readable index builder; it was not ingested.`,
			});
			continue;
		}
		if (read.expressionKeys > 0) {
			findings.push({
				code: "DRIZZLE_INDEX_EXPRESSION_UNREPRESENTABLE",
				detail: `Index "${read.name}" of table "${table}" keys on ${read.expressionKeys} SQL expression(s); the canonical IR indexes declared columns only, so the index was not ingested.`,
			});
			continue;
		}
		if (read.partial) {
			findings.push({
				code: "DRIZZLE_INDEX_PREDICATE_UNREPRESENTABLE",
				detail: `Index "${read.name}" of table "${table}" is partial (it has a WHERE predicate); the canonical IR carries its columns but not the predicate.`,
			});
		}
		if (read.orderedKeys.length > 0) {
			findings.push({
				code: "DRIZZLE_INDEX_KEY_ORDER_UNREPRESENTABLE",
				detail: `Index "${read.name}" of table "${table}" keys ${read.orderedKeys.map((key) => `"${key}"`).join(", ")} with a non-default sort order, nulls order, or operator class; the canonical IR carries the columns but not how they are ordered.`,
			});
		}
		indexes.push(
			Object.freeze({
				name: read.name,
				columns: Object.freeze([...read.columns]),
				unique: read.unique,
			}),
		);
	}
	return indexes.sort((left, right) => compareText(left.name, right.name));
}

function extraConfigEntries(
	produced: JsonValue,
): readonly (readonly [string, JsonValue])[] | undefined {
	if (Array.isArray(produced)) {
		return produced.map(
			// SAFETY: assertion to `ing(index), entry] as readonly [string, unknown], ` is required at this boundary.
			(entry, index) => [String(index), entry] as readonly [string, JsonValue],
		);
	}
	const record = asRecord(produced);
	if (record === undefined) return undefined;
	return (
		Object.keys(record)
			.sort()
			// SAFETY: assertion to `, record[key]] as readonly [string, unknown]); }` is required at this boundary.
			.map((key) => [key, record[key] ?? null] as const)
	);
}

/** Short, deterministic description of an unknown value for finding details. */
function describe<T>(value: T): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (value instanceof Error) return `${value.name}: ${value.message}`;
	if (isJsonString(value)) return "string";
	if (isJsonNumber(value)) return "number";
	if (isJsonBoolean(value)) return "boolean";
	if (value === undefined) return "undefined";
	if (value instanceof Function) return "function";
	const named = constructorName(value);
	return named === undefined ? "object" : `object<${named}>`;
}

interface ConstructorHost {
	readonly constructor?: { readonly name: string };
}

/** Class name of a non-plain object, so a finding can name what it met. */
function constructorName<T>(value: T): string | undefined {
	const prototype = Object.getPrototypeOf(value);
	if (prototype === null || prototype === Object.prototype) return undefined;
	// SAFETY: prototype constructor is the host's class factory at this boundary.
	const factory = (prototype as ConstructorHost).constructor;
	if (!(factory instanceof Function)) return undefined;
	return factory.name.length > 0 ? factory.name : undefined;
}
