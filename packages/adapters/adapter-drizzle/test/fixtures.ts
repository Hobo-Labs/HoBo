/**
 * Hand-built stand-ins for the objects `drizzle-orm` publishes.
 *
 * The adapter recognizes Drizzle values structurally and takes no dependency on
 * `drizzle-orm`, so the tests build the same shape the ORM does: the
 * `Symbol.for("drizzle:*")` registry symbols plus the plain properties of a
 * column descriptor. Building the fixtures by hand is deliberate — it is the
 * only way to prove the recognizer matches the published shape rather than a
 * convenience shape invented for the tests, and it keeps the test suite free of
 * the ORM too.
 */

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

/**
 * Column-shaped enough to be recognized (it has a name and a `getSQLType`) but
 * with no readable SQL type behind it — the shape a future Drizzle column class
 * this adapter does not understand would present.
 */
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
	// Column descriptors are also enumerable string properties on a real table.
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

/** Mimics a drizzle-kit index builder: state parked on a `config` property. */
export function indexBuilder(
	name: string,
	columns: readonly (string | JsonObject)[],
	unique = false,
): JsonObject {
	return { config: { name, columns: [...columns], unique } };
}

/** A partial index: the same builder with a `where` SQL object parked on it. */
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

/** Mimics drizzle-orm's `SQL` object: an expression is a list of query chunks. */
export function sqlExpression(text: string): JsonObject {
	return { queryChunks: [{ value: [text] }] };
}

/** Mimics drizzle-orm's `IndexedColumn`: a column plus how the index keys it. */
export function indexedColumn(
	name: string,
	indexConfig: JsonObject = { order: "asc", nulls: "last" },
): JsonObject {
	return { name, indexConfig };
}

/** The representative schema module the ingestion tests read. */
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
