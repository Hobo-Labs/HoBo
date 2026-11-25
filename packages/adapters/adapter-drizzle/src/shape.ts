/**
 * Structural recognition of Drizzle ORM values.
 *
 * This package deliberately does **not** depend on `drizzle-orm`. A HoBo
 * adapter that pulled the ORM into the dependency graph would make every
 * consumer of the schema-diff port carry an ORM they may not use, and would
 * pin the ORM's major version into HoBo's own release train. Instead the
 * adapter reads the shape Drizzle actually publishes on its objects: the
 * `Symbol.for("drizzle:*")` well-known symbols and the plain properties of a
 * column descriptor. Those symbols are the ORM's cross-instance contract —
 * they are registry symbols precisely so that separately-installed copies of
 * `drizzle-orm` interoperate — which makes them the honest thing to match on.
 *
 * Everything here is a predicate or a reader. Nothing throws: an unreadable
 * value is reported to the caller, which turns it into an impedance finding.
 */

/** Well-known Drizzle registry symbols (see `Table.Symbol` in `drizzle-orm`). */
import {
	isJsonBoolean,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

export const DRIZZLE_NAME_SYMBOL = Symbol.for("drizzle:Name");
export const DRIZZLE_COLUMNS_SYMBOL = Symbol.for("drizzle:Columns");
export const DRIZZLE_EXTRA_CONFIG_COLUMNS_SYMBOL = Symbol.for(
	"drizzle:ExtraConfigColumns",
);
export const DRIZZLE_EXTRA_CONFIG_BUILDER_SYMBOL = Symbol.for(
	"drizzle:ExtraConfigBuilder",
);
export const DRIZZLE_SCHEMA_SYMBOL = Symbol.for("drizzle:Schema");
export const DRIZZLE_IS_VIEW_SYMBOL = Symbol.for("drizzle:IsDrizzleView");

/**
 * Inline foreign keys are stored under a dialect-prefixed symbol
 * (`drizzle:PgInlineForeignKeys`, `drizzle:MySqlInlineForeignKeys`, …), so the
 * reader matches by description suffix rather than by an exact symbol.
 */
const INLINE_FOREIGN_KEYS_SUFFIX = "InlineForeignKeys";

/** Column type prefixes that identify a non-postgres Drizzle dialect. */
const NON_POSTGRES_COLUMN_PREFIXES = Object.freeze([
	"MySql",
	"SQLite",
	"SingleStore",
] as const);

export type UnknownRecord = JsonObject;
export type ExtraConfigBuilder = (columns: UnknownRecord) => JsonValue;

/** Host object published by drizzle-orm (string and well-known symbol keys). */
export interface DrizzleHost {
	readonly [key: string]: JsonValue | undefined;
}

interface SymbolBag {
	[key: symbol]: JsonValue | ExtraConfigBuilder | undefined;
}

/** Narrows to an indexable object without asserting anything about its keys. */
export function asRecord<T>(value: T): UnknownRecord | undefined {
	return isJsonObject(value) ? value : undefined;
}

function symbolValue<T>(
	value: T,
	symbol: symbol,
): JsonValue | ExtraConfigBuilder | undefined {
	if (value === null || value === undefined) return undefined;
	// SAFETY: drizzle hosts carry well-known registry symbols at this boundary.
	const bag: SymbolBag = value as never;
	return bag[symbol];
}

function ownSymbolsOf<T>(value: T): readonly symbol[] {
	const seen: symbol[] = [];
	let cursor: object | null = null;
	if (value !== null && value !== undefined) {
		// SAFETY: drizzle hosts are objects walked for registry symbols.
		cursor = value as never;
	}
	while (cursor !== null && cursor !== Object.prototype) {
		seen.push(...Object.getOwnPropertySymbols(cursor));
		// SAFETY: prototype walk stays on object hosts at this drizzle boundary.
		cursor = Object.getPrototypeOf(cursor) as object | null;
	}
	return seen;
}

/** A Drizzle table publishes both a SQL name and a column map under registry symbols. */
export function isDrizzleTable<T>(value: T): value is T & DrizzleHost {
	if (!isJsonObject(value)) return false;
	if (symbolValue(value, DRIZZLE_IS_VIEW_SYMBOL) === true) return false;
	return (
		isJsonString(symbolValue(value, DRIZZLE_NAME_SYMBOL)) &&
		asRecord(symbolValue(value, DRIZZLE_COLUMNS_SYMBOL)) !== undefined
	);
}

export function isDrizzleView<T>(value: T): value is T & DrizzleHost {
	return (
		isJsonObject(value) && symbolValue(value, DRIZZLE_IS_VIEW_SYMBOL) === true
	);
}

export function tableName<T>(table: T): string {
	const name = symbolValue(table, DRIZZLE_NAME_SYMBOL);
	return isJsonString(name) ? name : "";
}

/** The non-default postgres schema a table is bound to, when it declares one. */
export function tableSchema<T>(table: T): string | undefined {
	const schema = symbolValue(table, DRIZZLE_SCHEMA_SYMBOL);
	return isJsonString(schema) && schema.length > 0 ? schema : undefined;
}

export function tableColumns<T>(table: T): UnknownRecord {
	return asRecord(symbolValue(table, DRIZZLE_COLUMNS_SYMBOL)) ?? {};
}

export function extraConfigColumns<T>(table: T): UnknownRecord {
	return (
		asRecord(symbolValue(table, DRIZZLE_EXTRA_CONFIG_COLUMNS_SYMBOL)) ??
		tableColumns(table)
	);
}

export function extraConfigBuilder<T>(
	table: T,
): ExtraConfigBuilder | undefined {
	const builder = symbolValue(table, DRIZZLE_EXTRA_CONFIG_BUILDER_SYMBOL);
	if (!(builder instanceof Function)) return undefined;
	// SAFETY: extra-config builder is the ExtraConfigBuilder callback at this boundary.
	return builder as ExtraConfigBuilder;
}

/** True when the table carries at least one inline foreign key under any dialect symbol. */
export function hasInlineForeignKeys<T>(table: T): boolean {
	for (const symbol of ownSymbolsOf(table)) {
		if (symbol.description?.endsWith(INLINE_FOREIGN_KEYS_SUFFIX) !== true) {
			continue;
		}
		const value = symbolValue(table, symbol);
		if (Array.isArray(value) && value.length > 0) return true;
	}
	return false;
}

export interface DrizzleColumnLike {
	readonly name: string;
	readonly columnType?: string;
	readonly dataType?: string;
	readonly notNull?: boolean;
	readonly primary?: boolean;
	readonly isUnique?: boolean;
	readonly hasDefault?: boolean;
	readonly default?: JsonValue;
	readonly defaultFn?: JsonValue;
	readonly getSQLType?: () => JsonValue;
}

/** A column descriptor is anything with a SQL name plus one readable type source. */
export function isDrizzleColumn<T>(value: T): value is T & DrizzleColumnLike {
	const record = asRecord(value);
	if (record === undefined) return false;
	if (!isJsonString(record.name) || record.name.length === 0) {
		return false;
	}
	return (
		record.getSQLType instanceof Function ||
		isJsonString(record.columnType) ||
		isJsonString(record.dataType)
	);
}

/**
 * Reads the SQL type in the order Drizzle itself would: the rendered SQL type
 * first (it carries length/precision), then the class discriminator, then the
 * coarse JS data type. `getSQLType` is invoked defensively — it is third-party
 * code and a throw here must become a finding, not a crash.
 */
export function readColumnSqlType(
	column: DrizzleColumnLike,
): string | undefined {
	const rendered = renderedSqlType(column);
	if (rendered !== undefined) return rendered;
	if (isJsonString(column.columnType) && column.columnType.length > 0) {
		return normalizeColumnType(column.columnType);
	}
	if (isJsonString(column.dataType) && column.dataType.length > 0) {
		return column.dataType;
	}
	return undefined;
}

function renderedSqlType(column: DrizzleColumnLike): string | undefined {
	if (!(column.getSQLType instanceof Function)) return undefined;
	try {
		const rendered = column.getSQLType();
		return isJsonString(rendered) && rendered.length > 0 ? rendered : undefined;
	} catch {
		return undefined;
	}
}

/** `PgVarchar` → `varchar`; unknown classes degrade to their lowercased name. */
function normalizeColumnType(columnType: string): string {
	const withoutDialect = columnType.replace(
		/^(Pg|MySql|SQLite|SingleStore)/u,
		"",
	);
	const stem = withoutDialect.length > 0 ? withoutDialect : columnType;
	return stem.toLowerCase();
}

export function isNonPostgresColumn(column: DrizzleColumnLike): boolean {
	const columnType = column.columnType;
	if (!isJsonString(columnType)) return false;
	return NON_POSTGRES_COLUMN_PREFIXES.some((prefix) =>
		columnType.startsWith(prefix),
	);
}

export interface DrizzleIndexLike {
	readonly name: string;
	readonly columns: readonly string[];
	readonly unique: boolean;
	/** Key entries that are SQL expressions rather than declared columns. */
	readonly expressionKeys: number;
	/** True when the builder carries a `WHERE` predicate (a partial index). */
	readonly partial: boolean;
	/** Declared columns keyed with a non-default sort order, nulls order, or operator class. */
	readonly orderedKeys: readonly string[];
}

/**
 * Reads an entry returned by a table's extra-config callback. Drizzle index and
 * unique-constraint builders park their state on a `config` property carrying a
 * name, the key entries, and (for indexes) a `unique` flag. Anything that does
 * not present all three is refused so the caller can record it as impedance.
 *
 * A key entry is either a declared column (a string, or an object with a
 * `name`) or a SQL expression (Drizzle's `SQL` object, recognised by its
 * `queryChunks`). Expressions, a `where` predicate, and per-key ordering are
 * reported alongside the columns rather than dropped: the canonical IR cannot
 * carry them, and the caller turns each into an impedance finding.
 */
export function readIndexBuilder<T>(value: T): DrizzleIndexLike | undefined {
	const builder = asRecord(value);
	const config = asRecord(builder?.config);
	if (config === undefined) return undefined;
	const name = config.name;
	const columns = config.columns;
	const unique = config.unique;
	if (!isJsonString(name) || name.length === 0) return undefined;
	if (!Array.isArray(columns) || columns.length === 0) return undefined;
	if (!isJsonBoolean(unique)) return undefined;
	const columnNames: string[] = [];
	const orderedKeys: string[] = [];
	let expressionKeys = 0;
	for (const entry of columns) {
		const record = asRecord(entry);
		const columnName = isJsonString(entry) ? entry : record?.name;
		if (isJsonString(columnName) && columnName.length > 0) {
			columnNames.push(columnName);
			if (hasKeyOptions(asRecord(record?.indexConfig))) {
				orderedKeys.push(columnName);
			}
			continue;
		}
		if (!Array.isArray(record?.queryChunks)) return undefined;
		expressionKeys += 1;
	}
	return Object.freeze({
		name,
		columns: Object.freeze(columnNames),
		unique,
		expressionKeys,
		partial: config.where !== undefined && config.where !== null,
		orderedKeys: Object.freeze(orderedKeys),
	});
}

/**
 * Drizzle stamps every indexed column with `{ order: "asc", nulls: "last" }`.
 * Anything else, or an operator class, changes the index the database builds.
 */
function hasKeyOptions(indexConfig: UnknownRecord | undefined): boolean {
	if (indexConfig === undefined) return false;
	const { order, nulls, opClass } = indexConfig;
	return (
		(isJsonString(order) && order !== "asc") ||
		(isJsonString(nulls) && nulls !== "last") ||
		(isJsonString(opClass) && opClass.length > 0)
	);
}
