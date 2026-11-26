import type { DatasetSchema } from "@hobo/data-core";
import {
	METADATA_TABLES,
	OPEN_FIELDS_COLUMN,
	qualifiedName,
	quoteIdentifier,
	TENANT_COLUMN,
} from "./identifiers.js";
import { keyFieldsOf, parameterExpression, selectExpression } from "./types.js";

export const FENCED_WRITE_SQLSTATE = "HB001";
export const TRUNCATE_REFUSED_SQLSTATE = "HB002";
export const FENCE_TOKEN_SETTING = "hobo.fence_token";

export const FENCE_TRIGGER = "hobo_fence_guard";
export const TRUNCATE_TRIGGER = "hobo_truncate_guard";
export const BOOTSTRAP_MARKER = "hobo-data-postgres bootstrap 3";
const FENCE_RELEASE_TRIGGER = "hobo_fence_operation_release_guard";

export function bootstrapProbe(namespace: string): string {
	return `${qualifiedName(namespace, TRUNCATE_TRIGGER)}()`;
}

export function bootstrapStatements(namespace: string): readonly string[] {
	const meta = (name: string): string => qualifiedName(namespace, name);
	const datasets = meta(METADATA_TABLES.datasets);
	const fences = meta(METADATA_TABLES.fences);
	const operations = meta(METADATA_TABLES.fenceOperations);
	const blockedBy = (tenants: string): string =>
		`SELECT EXISTS (SELECT 1 FROM ${fences} f WHERE f.dataset = TG_TABLE_NAME AND f.tenant IN (${tenants}) AND f.token IS DISTINCT FROM presented) OR EXISTS (SELECT 1 FROM ${operations} o WHERE o.dataset = TG_TABLE_NAME AND o.status = 'held' AND o.tenant IN (${tenants})) INTO blocked`;
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
		`CREATE TABLE IF NOT EXISTS ${operations} (
	dataset text NOT NULL, tenant text NOT NULL, operation_id text NOT NULL,
	route_digest text NOT NULL, receiver_key_id text NOT NULL, receiver_key_digest text NOT NULL,
	fence_token_digest text NOT NULL, status text NOT NULL CHECK (status IN ('held','completed')),
	PRIMARY KEY (dataset, tenant, operation_id)
)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS hobo_one_held_fence_operation ON ${operations} (dataset, tenant) WHERE status = 'held'`,
		`CREATE TABLE IF NOT EXISTS ${meta(METADATA_TABLES.fencePolicy)} (id integer PRIMARY KEY CHECK (id = 1))`,
		`CREATE TABLE IF NOT EXISTS ${meta(METADATA_TABLES.fenceReceivers)} (key_id text PRIMARY KEY, key_digest text NOT NULL)`,
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
		// The metadata tables belong to the binding's role alone. The fence
		// table holds tokens — whoever reads one writes through the fence —
		// and a lock on a registry row is what `raise` waits on, so neither
		// may be reachable by a role that merely writes a dataset.
		`REVOKE ALL ON TABLE ${Object.values(METADATA_TABLES).map(meta).join(", ")} FROM PUBLIC`,
		`CREATE OR REPLACE FUNCTION ${meta(FENCE_RELEASE_TRIGGER)}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $hobo$
BEGIN
	UPDATE ${datasets} SET fence_epoch = fence_epoch + 1 WHERE dataset = OLD.dataset;
	IF EXISTS (SELECT 1 FROM ${operations} o WHERE o.dataset = OLD.dataset AND o.status = 'held' AND (o.tenant = '' OR OLD.tenant = '' OR o.tenant = OLD.tenant)) THEN
		RAISE EXCEPTION 'native fence operation is still held' USING ERRCODE = 'HB003';
	END IF;
	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END
$hobo$`,
		`CREATE OR REPLACE TRIGGER ${quoteIdentifier(FENCE_RELEASE_TRIGGER)} BEFORE DELETE OR UPDATE ON ${fences} FOR EACH ROW EXECUTE FUNCTION ${meta(FENCE_RELEASE_TRIGGER)}()`,
		`ALTER TABLE ${fences} ENABLE ALWAYS TRIGGER ${quoteIdentifier(FENCE_RELEASE_TRIGGER)}`,
		// The fence, enforced by the store. The share lock on the dataset's
		// metadata row is what makes raising a fence a real barrier: `raise`
		// updates that row, so it waits for every in-flight writer to finish
		// and every later writer waits for it — and then sees the fence.
		//
		// SECURITY DEFINER, so a writing role needs — and is given — no
		// privilege on the metadata tables: it cannot read a token or hold the
		// registry lock itself. And a pinned search path, so the comparisons
		// below resolve to the system's own operators whatever the writer's
		// session put on its path; every table is named in full.
		`CREATE OR REPLACE FUNCTION ${meta(FENCE_TRIGGER)}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $hobo$
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
		`CREATE OR REPLACE FUNCTION ${meta(TRUNCATE_TRIGGER)}() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $hobo$
BEGIN
	RAISE EXCEPTION 'dataset % cannot be truncated; delete its records so the change is fenced and captured', TG_TABLE_NAME
		USING ERRCODE = '${TRUNCATE_REFUSED_SQLSTATE}';
END
$hobo$`,
		`COMMENT ON FUNCTION ${bootstrapProbe(namespace)} IS '${BOOTSTRAP_MARKER}'`,
	];
}

export function guardStatements(
	namespace: string,
	dataset: string,
): readonly string[] {
	const table = qualifiedName(namespace, dataset);
	return [
		`CREATE OR REPLACE TRIGGER ${quoteIdentifier(FENCE_TRIGGER)} BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${qualifiedName(namespace, FENCE_TRIGGER)}()`,
		`ALTER TABLE ${table} ENABLE ALWAYS TRIGGER ${quoteIdentifier(FENCE_TRIGGER)}`,
		`CREATE OR REPLACE TRIGGER ${quoteIdentifier(TRUNCATE_TRIGGER)} BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION ${qualifiedName(namespace, TRUNCATE_TRIGGER)}()`,
		`ALTER TABLE ${table} ENABLE ALWAYS TRIGGER ${quoteIdentifier(TRUNCATE_TRIGGER)}`,
	];
}

export interface DatasetStatements {
	readonly upsert: string;
	readonly remove: string;
	readonly readOne: string;
	scan(scoped: boolean, resumed: boolean): string;
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
			const row = (column: string): string => `r.${column}`;
			let next = 1;
			const predicates: string[] = [];
			if (scoped) {
				predicates.push(`${row(tenant)} = $${next}::text`);
				next += 1;
			}
			if (resumed) {
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
