/**
 * Statement text for the engine binding. Pure: a namespace and a schema in,
 * SQL out. Nothing here executes, so the exact text a dataset produces is
 * testable without a server.
 *
 * Two rules hold throughout. Every parameter is cast in the statement, so a
 * driver never has to guess a type. And every selected column is text, so a
 * driver never gets to reinterpret one.
 */
import type { DatasetSchema } from "@hobo/data-core";
import {
	METADATA_TABLES,
	OPEN_FIELDS_COLUMN,
	qualifiedName,
	quoteIdentifier,
	TENANT_COLUMN,
} from "./identifiers.js";
import { keyFieldsOf, parameterExpression, selectExpression } from "./types.js";

// public-contract: SQLSTATE the fence trigger raises; the binding maps it to FencedWriteError.
export const FENCED_WRITE_SQLSTATE = "HB001";
// public-contract: SQLSTATE the truncate guard raises on a dataset table.
export const TRUNCATE_REFUSED_SQLSTATE = "HB002";
// public-contract: session setting a migration authority presents its fence token in.
export const FENCE_TOKEN_SETTING = "hobo.fence_token";

// public-contract: name of the row trigger that enforces the write fence in the store.
export const FENCE_TRIGGER = "hobo_fence_guard";
// public-contract: name of the statement trigger that refuses TRUNCATE on a dataset table.
export const TRUNCATE_TRIGGER = "hobo_truncate_guard";
// public-contract: comment stamped on the last object the bootstrap creates; a binding that finds it skips the DDL.
export const BOOTSTRAP_MARKER = "hobo-data-postgres bootstrap 1";

/**
 * The object whose comment says a namespace is bootstrapped, as text the
 * server resolves to a function — or to NULL when it does not exist yet.
 */
export function bootstrapProbe(namespace: string): string {
	return `${qualifiedName(namespace, TRUNCATE_TRIGGER)}()`;
}

/**
 * The statements that create the binding's metadata tables and functions.
 * Idempotent, and stamped last: a namespace carrying `BOOTSTRAP_MARKER` has
 * all of it, so a later binding can skip the DDL entirely.
 */
export function bootstrapStatements(namespace: string): readonly string[] {
	const meta = (name: string): string => qualifiedName(namespace, name);
	const datasets = meta(METADATA_TABLES.datasets);
	const fences = meta(METADATA_TABLES.fences);
	const blockedBy = (tenants: string): string =>
		`SELECT EXISTS (SELECT 1 FROM ${fences} f WHERE f.dataset = TG_TABLE_NAME AND f.tenant IN (${tenants}) AND f.token IS DISTINCT FROM presented) INTO blocked`;
	return [
		`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(namespace)}`,
		`CREATE TABLE IF NOT EXISTS ${datasets} (
	dataset text PRIMARY KEY,
	schema_json text NOT NULL,
	schema_digest text NOT NULL,
	fence_epoch bigint NOT NULL DEFAULT 0
)`,
		`CREATE TABLE IF NOT EXISTS ${fences} (
	dataset text NOT NULL,
	tenant text NOT NULL,
	token text NOT NULL,
	reason text NOT NULL,
	PRIMARY KEY (dataset, tenant)
)`,
		`CREATE TABLE IF NOT EXISTS ${meta(METADATA_TABLES.watermarks)} (
	dataset text NOT NULL,
	source text NOT NULL,
	log_position text NOT NULL,
	PRIMARY KEY (dataset, source)
)`,
		`CREATE TABLE IF NOT EXISTS ${meta(METADATA_TABLES.subscriptions)} (
	subscription text PRIMARY KEY,
	dataset text NOT NULL,
	tenant text NOT NULL,
	slot_name text NOT NULL,
	publication_name text NOT NULL,
	start_position text NOT NULL
)`,
		`CREATE TABLE IF NOT EXISTS ${meta(METADATA_TABLES.schemaSnapshots)} (
	snapshot_ref text PRIMARY KEY,
	taken_at text NOT NULL,
	tables_json text NOT NULL
)`,
		// The fence, enforced by the store. The share lock on the dataset's
		// metadata row is what makes raising a fence a real barrier: `raise`
		// updates that row, so it waits for every in-flight writer to finish
		// and every later writer waits for it — and then sees the fence.
		`CREATE OR REPLACE FUNCTION ${meta(FENCE_TRIGGER)}() RETURNS trigger LANGUAGE plpgsql AS $hobo$
DECLARE
	presented text := nullif(current_setting('${FENCE_TOKEN_SETTING}', true), '');
	blocked boolean;
BEGIN
	PERFORM 1 FROM ${datasets} d WHERE d.dataset = TG_TABLE_NAME FOR SHARE;
	IF TG_OP = 'INSERT' THEN
		${blockedBy("'', NEW.tenant_id")};
	ELSIF TG_OP = 'DELETE' THEN
		${blockedBy("'', OLD.tenant_id")};
	ELSE
		${blockedBy("'', NEW.tenant_id, OLD.tenant_id")};
	END IF;
	IF blocked THEN
		RAISE EXCEPTION 'dataset % is fenced; write authority has moved', TG_TABLE_NAME
			USING ERRCODE = '${FENCED_WRITE_SQLSTATE}';
	END IF;
	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END
$hobo$`,
		// TRUNCATE fires no row trigger and carries no keys, so it would slip
		// past the fence and could not be captured as record changes.
		`CREATE OR REPLACE FUNCTION ${meta(TRUNCATE_TRIGGER)}() RETURNS trigger LANGUAGE plpgsql AS $hobo$
BEGIN
	RAISE EXCEPTION 'dataset % cannot be truncated; delete its records so the change is fenced and captured', TG_TABLE_NAME
		USING ERRCODE = '${TRUNCATE_REFUSED_SQLSTATE}';
END
$hobo$`,
		`COMMENT ON FUNCTION ${bootstrapProbe(namespace)} IS '${BOOTSTRAP_MARKER}'`,
	];
}

/** The statements that put a dataset table behind the fence. */
export function guardStatements(
	namespace: string,
	dataset: string,
): readonly string[] {
	const table = qualifiedName(namespace, dataset);
	return [
		`CREATE OR REPLACE TRIGGER ${quoteIdentifier(FENCE_TRIGGER)} BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${qualifiedName(namespace, FENCE_TRIGGER)}()`,
		// ALWAYS: the fence also holds for a session in replica mode, which is
		// how a native logical-replication apply worker writes.
		`ALTER TABLE ${table} ENABLE ALWAYS TRIGGER ${quoteIdentifier(FENCE_TRIGGER)}`,
		`CREATE OR REPLACE TRIGGER ${quoteIdentifier(TRUNCATE_TRIGGER)} BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION ${qualifiedName(namespace, TRUNCATE_TRIGGER)}()`,
		`ALTER TABLE ${table} ENABLE ALWAYS TRIGGER ${quoteIdentifier(TRUNCATE_TRIGGER)}`,
	];
}

/** Every statement the record ports run against one dataset table. */
export interface DatasetStatements {
	/** Parameters: tenant, one per field in schema order, then the overflow object when the schema is open. */
	readonly upsert: string;
	/** Parameters: tenant, then one per key field. */
	readonly remove: string;
	/** Parameters: tenant, then one per key field. */
	readonly readOne: string;
	/**
	 * One keyset page in primary-key order. Parameters: the tenant when
	 * `scoped`; the previous page's last tenant and key values when
	 * `resumed`; then the page size.
	 */
	scan(scoped: boolean, resumed: boolean): string;
	/** Parameter: the tenant, when `scoped`. */
	removeScope(scoped: boolean): string;
}

export function datasetStatements(
	namespace: string,
	schema: DatasetSchema,
): DatasetStatements {
	const table = qualifiedName(namespace, schema.name);
	const tenant = quoteIdentifier(TENANT_COLUMN);
	const keys = keyFieldsOf(schema);
	const keyColumns = [tenant, ...keys.map((key) => quoteIdentifier(key.name))];

	const insertColumns = [
		tenant,
		...schema.fields.map((field) => quoteIdentifier(field.name)),
		...(schema.open ? [quoteIdentifier(OPEN_FIELDS_COLUMN)] : []),
	];
	const insertValues = [
		"$1::text",
		...schema.fields.map((field, index) =>
			parameterExpression(field.type, index + 2),
		),
		...(schema.open ? [`$${schema.fields.length + 2}::jsonb`] : []),
	];
	const assignments = insertColumns
		.filter((column) => !keyColumns.includes(column))
		.map((column) => `${column} = EXCLUDED.${column}`);
	const conflict =
		assignments.length === 0
			? "DO NOTHING"
			: `DO UPDATE SET ${assignments.join(", ")}`;

	const keyPredicate = [
		`${tenant} = $1::text`,
		...keys.map(
			(key, index) =>
				`${quoteIdentifier(key.name)} = ${parameterExpression(key.type, index + 2)}`,
		),
	].join(" AND ");

	const selectList = [
		`${tenant} AS ${tenant}`,
		...schema.fields.map(
			(field) =>
				`${selectExpression(field.type, field.name)} AS ${quoteIdentifier(field.name)}`,
		),
		...(schema.open
			? [
					`${quoteIdentifier(OPEN_FIELDS_COLUMN)}::text AS ${quoteIdentifier(OPEN_FIELDS_COLUMN)}`,
				]
			: []),
	].join(", ");

	return {
		upsert: `INSERT INTO ${table} (${insertColumns.join(", ")}) VALUES (${insertValues.join(", ")}) ON CONFLICT (${keyColumns.join(", ")}) ${conflict}`,
		remove: `DELETE FROM ${table} WHERE ${keyPredicate}`,
		readOne: `SELECT ${selectList} FROM ${table} WHERE ${keyPredicate}`,
		scan(scoped, resumed) {
			// Columns are qualified with the row alias throughout. The select
			// list re-uses each column's name for its text form, and an
			// unqualified name in ORDER BY would pick that text — sorting an
			// integer key as a string and breaking the keyset.
			const row = (column: string): string => `r.${column}`;
			let next = 1;
			const predicates: string[] = [];
			if (scoped) {
				predicates.push(`${row(tenant)} = $${next}::text`);
				next += 1;
			}
			if (resumed) {
				// Text bounds name the key collation explicitly, so the
				// comparison can never fall back to the database default.
				const bounds = [`$${next}::text COLLATE "C"`];
				next += 1;
				for (const key of keys) {
					const bound = parameterExpression(key.type, next);
					bounds.push(key.type === "string" ? `${bound} COLLATE "C"` : bound);
					next += 1;
				}
				predicates.push(
					`(${keyColumns.map(row).join(", ")}) > (${bounds.join(", ")})`,
				);
			}
			const where =
				predicates.length === 0 ? "" : ` WHERE ${predicates.join(" AND ")}`;
			return `SELECT ${selectList} FROM ${table} AS r${where} ORDER BY ${keyColumns.map(row).join(", ")} LIMIT $${next}::bigint`;
		},
		removeScope: (scoped) =>
			`DELETE FROM ${table}${scoped ? ` WHERE ${tenant} = $1::text` : ""}`,
	};
}
