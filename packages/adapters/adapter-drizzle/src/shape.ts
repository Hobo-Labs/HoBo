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

const INLINE_FOREIGN_KEYS_SUFFIX = "InlineForeignKeys";

const NON_POSTGRES_COLUMN_PREFIXES = Object.freeze([
	"MySql",
	"SQLite",
	"SingleStore",
] as const);

export type UnknownRecord = JsonObject;
export type ExtraConfigBuilder = (columns: UnknownRecord) => JsonValue;

export interface DrizzleHost {
	readonly [key: string]: JsonValue | undefined;
}

interface SymbolBag {
	[key: symbol]: JsonValue | ExtraConfigBuilder | undefined;
}

export function asRecord<T>(value: T): UnknownRecord | undefined {
	return isJsonObject(value) ? value : undefined;
}

function symbolValue<T>(
	value: T,
	symbol: symbol,
): JsonValue | ExtraConfigBuilder | undefined {
	if (value === null || value === undefined) return undefined;
	const bag: SymbolBag = value as never;
	return bag[symbol];
}

function ownSymbolsOf<T>(value: T): readonly symbol[] {
	const seen: symbol[] = [];
	let cursor: object | null = null;
	if (value !== null && value !== undefined) {
		cursor = value as never;
	}
	while (cursor !== null && cursor !== Object.prototype) {
		seen.push(...Object.getOwnPropertySymbols(cursor));
		cursor = Object.getPrototypeOf(cursor) as object | null;
	}
	return seen;
}

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
	return builder as ExtraConfigBuilder;
}

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
	readonly expressionKeys: number;
	readonly partial: boolean;
	readonly orderedKeys: readonly string[];
	readonly options: readonly string[];
}

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
		options: readIndexOptions(config),
	});
}

function readIndexOptions(config: UnknownRecord): readonly string[] {
	const options: string[] = [];
	if (config.method !== undefined && config.method !== "btree") {
		options.push(
			isJsonString(config.method) ? `USING ${config.method}` : "access method",
		);
	}
	const storage = asRecord(config.with);
	if (
		(storage !== undefined && Object.keys(storage).length > 0) ||
		(storage === undefined && config.with !== undefined && config.with !== null)
	) {
		options.push("storage parameters");
	}
	if (config.concurrently === true) options.push("CONCURRENTLY");
	if (config.only === true) options.push("ONLY");
	return Object.freeze(options);
}

function hasKeyOptions(indexConfig: UnknownRecord | undefined): boolean {
	if (indexConfig === undefined) return false;
	const { order, nulls, opClass } = indexConfig;
	return (
		(isJsonString(order) && order !== "asc") ||
		(isJsonString(nulls) && nulls !== "last") ||
		(isJsonString(opClass) && opClass.length > 0)
	);
}
