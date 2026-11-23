import type { JsonObject, JsonValue } from "../src/json.js";
import type { DrizzleColumnLike, ExtraConfigBuilder } from "../src/shape.js";

export interface FixtureHost {
	[key: string]: JsonValue | ExtraConfigBuilder | undefined;
	[key: symbol]: JsonValue | ExtraConfigBuilder | undefined;
}

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
	readonly defaultFn?: JsonValue;
}

export function column(
	name: string,
	overrides: ColumnOverrides = {},
): DrizzleColumnLike {
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

export function typelessColumn(name: string): DrizzleColumnLike {
	return { name, getSQLType: (): undefined => undefined };
}

export interface TableOverrides {
	readonly schema?: string;
	readonly inlineForeignKeys?: readonly JsonValue[];
	readonly extraConfigBuilder?: ExtraConfigBuilder;
	readonly extraConfigColumns?: JsonObject;
}

export function table(
	sqlName: string,
	columns: JsonObject,
	overrides: TableOverrides = {},
): FixtureHost {
	const built: FixtureHost = {
		[DRIZZLE_NAME]: sqlName,
		[DRIZZLE_COLUMNS]: columns,
	};
	if (overrides.schema !== undefined) built[DRIZZLE_SCHEMA] = overrides.schema;
	if (overrides.inlineForeignKeys !== undefined) {
		built[DRIZZLE_PG_INLINE_FOREIGN_KEYS] = overrides.inlineForeignKeys;
	}
	if (overrides.extraConfigBuilder !== undefined) {
		built[DRIZZLE_EXTRA_CONFIG_BUILDER] = overrides.extraConfigBuilder;
	}
	if (overrides.extraConfigColumns !== undefined) {
		built[DRIZZLE_EXTRA_CONFIG_COLUMNS] = overrides.extraConfigColumns;
	}
	for (const [property, value] of Object.entries(columns)) {
		built[property] = value;
	}
	return built;
}

export function view(sqlName: string): FixtureHost {
	return {
		[DRIZZLE_IS_VIEW]: true,
		[DRIZZLE_NAME]: sqlName,
		[DRIZZLE_COLUMNS]: {},
	};
}

export function indexBuilder(
	name: string,
	columns: readonly (string | JsonObject)[],
	unique = false,
): JsonObject {
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

export function representativeSchemaModule(): JsonObject {
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
