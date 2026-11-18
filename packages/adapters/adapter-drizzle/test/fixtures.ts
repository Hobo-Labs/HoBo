import type { JsonObject, JsonValue } from "../src/json.js";
import type { UnknownRecord } from "../src/shape.js";

export const DRIZZLE_NAME = Symbol.for("drizzle:Name");
export const DRIZZLE_COLUMNS = Symbol.for("drizzle:Columns");
export const DRIZZLE_SCHEMA = Symbol.for("drizzle:Schema");
export const DRIZZLE_EXTRA_CONFIG_BUILDER = Symbol.for(
	"drizzle:ExtraConfigBuilder",
);
export const DRIZZLE_EXTRA_CONFIG_COLUMNS = Symbol.for(
	"drizzle:ExtraConfigColumns",
);
export const DRIZZLE_IS_VIEW = Symbol.for("drizzle:IsDrizzleView");
export const DRIZZLE_PG_INLINE_FOREIGN_KEYS = Symbol.for(
	"drizzle:PgInlineForeignKeys",
);

export interface ColumnOverrides {
	readonly columnType?: string;
	readonly dataType?: string;
	readonly sqlType?: string | (() => JsonValue);
	readonly notNull?: boolean;
	readonly primary?: boolean;
	readonly isUnique?: boolean;
	readonly hasDefault?: boolean;
	readonly default?: JsonValue;
	readonly defaultFn?: JsonValue | (() => JsonValue);
}

export function column(name: string, overrides: ColumnOverrides = {}) {
	const sqlType = overrides.sqlType ?? "text";
	return {
		name,
		columnType: overrides.columnType ?? "PgText",
		dataType: overrides.dataType ?? "string",
		notNull: overrides.notNull ?? false,
		primary: overrides.primary ?? false,
		isUnique: overrides.isUnique ?? false,
		hasDefault: overrides.hasDefault ?? overrides.default !== undefined,
		getSQLType: sqlType instanceof Function ? sqlType : (): string => sqlType,
		...(overrides.default !== undefined
			? { default: overrides.default }
			: undefined),
		...(overrides.defaultFn !== undefined
			? { defaultFn: overrides.defaultFn }
			: undefined),
	};
}

export function typelessColumn(name: string) {
	return { name, getSQLType: (): undefined => undefined };
}

export interface TableOverrides {
	readonly schema?: string;
	readonly inlineForeignKeys?: readonly JsonValue[];
	readonly extraConfigBuilder?: (columns: UnknownRecord) => JsonValue | object;
	readonly extraConfigColumns?: JsonObject;
}

interface FixtureMetadata<Columns> {
	[DRIZZLE_NAME]: string;
	[DRIZZLE_COLUMNS]: Columns;
	[DRIZZLE_SCHEMA]?: string;
	[DRIZZLE_PG_INLINE_FOREIGN_KEYS]?: readonly JsonValue[];
	[DRIZZLE_EXTRA_CONFIG_BUILDER]?: NonNullable<
		TableOverrides["extraConfigBuilder"]
	>;
	[DRIZZLE_EXTRA_CONFIG_COLUMNS]?: JsonObject;
}

export function table<Columns extends object>(
	sqlName: string,
	columns: Columns,
	overrides: TableOverrides = {},
) {
	const metadata: FixtureMetadata<Columns> = {
		[DRIZZLE_NAME]: sqlName,
		[DRIZZLE_COLUMNS]: columns,
	};
	if (overrides.schema !== undefined)
		metadata[DRIZZLE_SCHEMA] = overrides.schema;
	if (overrides.inlineForeignKeys !== undefined)
		metadata[DRIZZLE_PG_INLINE_FOREIGN_KEYS] = overrides.inlineForeignKeys;
	if (overrides.extraConfigBuilder !== undefined)
		metadata[DRIZZLE_EXTRA_CONFIG_BUILDER] = overrides.extraConfigBuilder;
	if (overrides.extraConfigColumns !== undefined)
		metadata[DRIZZLE_EXTRA_CONFIG_COLUMNS] = overrides.extraConfigColumns;
	return { ...columns, ...metadata };
}

export function view(sqlName: string) {
	return {
		[DRIZZLE_IS_VIEW]: true,
		[DRIZZLE_NAME]: sqlName,
		[DRIZZLE_COLUMNS]: {},
	};
}

export function indexBuilder(
	name: string,
	columns: readonly (string | object)[],
	unique = false,
) {
	return { config: { name, columns: [...columns], unique } };
}

export function partialIndexBuilder(
	name: string,
	columns: readonly (string | JsonObject)[],
): JsonObject {
	return {
		config: {
			name,
			columns: [...columns],
			unique: false,
			where: sqlExpression("deleted_at IS NULL"),
		},
	};
}

export function sqlExpression(text: string): JsonObject {
	return { queryChunks: [{ value: [text] }] };
}

export function indexedColumn(
	name: string,
	indexConfig: JsonObject = { order: "asc", nulls: "last" },
): JsonObject {
	return { name, indexConfig };
}

export function representativeSchemaModule() {
	const usersColumns = {
		id: column("id", {
			columnType: "PgSerial",
			sqlType: "serial",
			primary: true,
			notNull: true,
		}),
		email: column("email", {
			sqlType: "varchar(320)",
			notNull: true,
			isUnique: true,
		}),
		displayName: column("display_name", { sqlType: "text" }),
		active: column("active", {
			columnType: "PgBoolean",
			sqlType: "boolean",
			notNull: true,
			default: true,
		}),
	};
	const postsColumns = {
		id: column("id", {
			columnType: "PgSerial",
			sqlType: "serial",
			primary: true,
			notNull: true,
		}),
		authorId: column("author_id", { sqlType: "integer", notNull: true }),
		title: column("title", {
			sqlType: "text",
			notNull: true,
			default: "untitled",
		}),
	};
	return {
		users: table("users", usersColumns, {
			extraConfigBuilder: () => [
				indexBuilder("users_email_idx", ["email"], true),
				indexBuilder("users_active_idx", [usersColumns.active]),
			],
		}),
		posts: table("posts", postsColumns, {
			inlineForeignKeys: [{ reference: "users.id" }],
		}),
	};
}
