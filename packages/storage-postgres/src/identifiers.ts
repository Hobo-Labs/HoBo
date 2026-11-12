import { StoragePostgresError } from "./errors.js";

/** A schema name this store may create: lower-case, unquoted-safe, <= 63 bytes. */
export type SchemaName = string & { readonly __brand: "storage-postgres.SchemaName" };

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/u;

/** Reserved namespaces a store must never take over. */
const RESERVED = new Set(["public", "information_schema"]);

export function parseSchemaName(value: unknown, path = "schema"): SchemaName {
	if (typeof value !== "string" || !SCHEMA_NAME.test(value)) {
		throw new StoragePostgresError(
			"invalid-config",
			`${path} must match ${SCHEMA_NAME.source}; received ${JSON.stringify(value)}`,
		);
	}
	if (RESERVED.has(value) || value.startsWith("pg_")) {
		throw new StoragePostgresError(
			"invalid-config",
			`${path} ${JSON.stringify(value)} is reserved; choose a dedicated schema`,
		);
	}
	// SAFETY: the pattern and reserved-name checks above are the brand's definition.
	return value as SchemaName;
}

/** Quote a parsed schema name as a SQL identifier. */
export function quoteSchema(schema: SchemaName): string {
	return `"${schema}"`;
}

/** Advisory-lock key text for one schema's migrations. */
export function migrationLockKey(schema: SchemaName): string {
	return `hobo.storage-postgres.migrate:${schema}`;
}

/** LISTEN/NOTIFY channel for one schema's live wake-ups. */
export function notifyChannel(schema: SchemaName): string {
	return `hobo_es_${schema}`.slice(0, 63);
}
