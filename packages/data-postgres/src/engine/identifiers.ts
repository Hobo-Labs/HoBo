/**
 * Identifier handling for the engine binding.
 *
 * `@hobo/data-core` already restricts dataset and field names to portable
 * lowercase identifiers. They are quoted here anyway: quoting costs nothing,
 * and it means a name that happens to be a reserved word (`user`, `order`)
 * is still a column rather than a syntax error.
 */
import { sha256Hex } from "@hobo/data-core";
import { PostgresDataError } from "../errors.js";

const NAMESPACE_PATTERN = /^[a-z][a-z0-9_]{0,62}$/u;

// public-contract: tenant column present on every dataset table; part of each primary key.
export const TENANT_COLUMN = "tenant_id";
// public-contract: overflow column holding the undeclared fields of an open dataset schema.
export const OPEN_FIELDS_COLUMN = "hobo_extra";

/** Metadata tables the binding keeps beside the dataset tables. */
export const METADATA_TABLES = Object.freeze({
	datasets: "hobo_data_datasets",
	fences: "hobo_data_fences",
	watermarks: "hobo_data_watermarks",
	subscriptions: "hobo_data_subscriptions",
	schemaSnapshots: "hobo_data_schema_snapshots",
} as const);

/** Names a dataset or a schema-port table may not take. */
export const RESERVED_TABLE_NAMES: readonly string[] = Object.freeze(
	Object.values(METADATA_TABLES),
);

/** The one constructor for a namespace (a server-side schema) name. */
export function parseNamespace(value: string): string {
	if (!NAMESPACE_PATTERN.test(value) || value.startsWith("pg_")) {
		throw new PostgresDataError(
			"ENGINE_OPTIONS_INVALID",
			"namespace must be a lowercase snake_case identifier of at most 63 bytes that does not start with pg_",
			{ detail: { field: "namespace" } },
		);
	}
	return value;
}

/** The one constructor for a table name the schema port is configured with. */
export function parseTableName(value: string): string {
	if (!NAMESPACE_PATTERN.test(value) || RESERVED_TABLE_NAMES.includes(value)) {
		throw new PostgresDataError(
			"ENGINE_OPTIONS_INVALID",
			"a schema-port table must be a lowercase snake_case identifier that is not one of the binding's own tables",
			{ detail: { field: "schemaTables" } },
		);
	}
	return value;
}

export function quoteIdentifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

export function qualifiedName(namespace: string, name: string): string {
	return `${quoteIdentifier(namespace)}.${quoteIdentifier(name)}`;
}

// domain-view: derived names; wire form is PostgresCaptureObjects in data-models/postgres_engine.proto.
export interface PostgresCaptureObjects {
	readonly slot: string;
	readonly publication: string;
}

/**
 * Slot and publication names for a subscription.
 *
 * A replication slot is cluster-wide and a publication is database-wide, but
 * a subscription name is only unique within one binding's namespace, and may
 * contain characters a slot name cannot (a slot allows lowercase letters,
 * digits, and underscore, at most 63 bytes). So both names are derived by
 * hashing: one half identifies the database and namespace, the other the
 * subscription. Two bindings never collide, and every slot one namespace
 * owns shares a prefix an operator can list.
 */
export function captureObjectNames(
	database: string,
	namespace: string,
	subscription: string,
): PostgresCaptureObjects {
	const owner = sha256Hex(`${database}\u0000${namespace}`).slice(0, 12);
	const reader = sha256Hex(subscription).slice(0, 24);
	return Object.freeze({
		slot: `hobo_s_${owner}_${reader}`,
		publication: `hobo_p_${owner}_${reader}`,
	});
}

/** A fresh server-side schema name for one schema-port snapshot. */
export function snapshotNamespace(namespace: string, nonce: string): string {
	return `hobo_snap_${sha256Hex(namespace).slice(0, 12)}_${nonce}`;
}
