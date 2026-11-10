/**
 * Schema apply for `in-place-evolve`: real expand / backfill / contract DDL,
 * a restorable snapshot, and a restore.
 *
 * DDL is transactional here, so a phase is one transaction and a failing
 * statement leaves nothing of the phase behind. The snapshot is a copy of the
 * configured tables into a separate server-side schema; restore drops the
 * live tables and recreates them from the copy. That genuinely restores
 * structure and data for an ordinary table — and it is refused, by name, for
 * a table carrying anything the copy cannot preserve.
 */
import { randomUUID } from "node:crypto";
import {
	DataCoreError,
	type JsonObject,
	type JsonValue,
	type SchemaApplyPort,
	type SchemaPhase,
	type SchemaPhaseResult,
	type SchemaSnapshotRef,
} from "@hobo/data-core";
import type { PostgresExecutor } from "./executor.js";
import { isPlainObject, isText } from "./guards.js";
import {
	qualifiedName,
	quoteIdentifier,
	snapshotNamespace,
} from "./identifiers.js";
import type { DatasetStore } from "./store.js";

/**
 * What makes a table unsafe to snapshot by copy. Each row of the preflight
 * query is one reason; the reasons are impedance codes of this engine.
 */
export const SCHEMA_SNAPSHOT_REFUSALS = Object.freeze({
	notOrdinary:
		"POSTGRES_SCHEMA_SNAPSHOT_ORDINARY_TABLES_ONLY: partitioned, inherited, or non-table relations are not copied faithfully",
	foreignKey:
		"POSTGRES_SCHEMA_SNAPSHOT_NO_FOREIGN_KEYS: a foreign key to or from the table would not survive drop-and-recreate",
	trigger:
		"POSTGRES_SCHEMA_SNAPSHOT_NO_TRIGGERS: a trigger on the table would not survive drop-and-recreate",
	sequence:
		"POSTGRES_SCHEMA_SNAPSHOT_NO_SEQUENCES: an identity or sequence-backed column would restart or lose its sequence",
	policy:
		"POSTGRES_SCHEMA_SNAPSHOT_NO_ROW_SECURITY: row security policies are not copied",
	grant:
		"POSTGRES_SCHEMA_SNAPSHOT_NO_GRANTS: privileges granted on the table or its columns are not copied",
	owner:
		"POSTGRES_SCHEMA_SNAPSHOT_SAME_OWNER_ONLY: a table owned by another role would be recreated owned by the restoring role, and its owner would lose it",
	publication:
		"POSTGRES_SCHEMA_SNAPSHOT_NOT_PUBLISHED: a table in a publication would be recreated outside it and silently drop out of logical replication",
	dataset:
		"POSTGRES_SCHEMA_SNAPSHOT_NOT_A_DATASET: a dataset table carries the fence and may be captured; it is not evolved through the raw schema port",
} as const);

function refusalText(reason: string): string {
	const found = Object.entries(SCHEMA_SNAPSHOT_REFUSALS).find(
		([key]) => key === reason,
	);
	return found?.[1] ?? reason;
}

function refusedPlan(message: string, table: string): DataCoreError {
	return new DataCoreError("INVALID_MIGRATION_PLAN", message, {
		detail: { table },
	});
}

function parseJsonText(text: string): JsonValue {
	// SAFETY: JSON.parse yields a JSON value at this document boundary.
	return JSON.parse(text) as JsonValue;
}

/**
 * One row per reason a table cannot be snapshotted. `$1` is the namespace,
 * `$2` the table, `$3` the dataset registry's regclass text.
 */
const PREFLIGHT = `
WITH target AS (
	SELECT c.oid, c.relkind, c.relrowsecurity, c.relacl, c.relowner, c.relnamespace
	FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
	WHERE n.nspname = $1::text AND c.relname = $2::text
)
SELECT 'notOrdinary' AS reason FROM target t
	WHERE t.relkind <> 'r'
		OR EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = t.oid OR i.inhparent = t.oid)
UNION ALL
SELECT 'foreignKey' FROM target t
	WHERE EXISTS (SELECT 1 FROM pg_constraint k WHERE k.contype = 'f' AND (k.conrelid = t.oid OR k.confrelid = t.oid))
UNION ALL
SELECT 'trigger' FROM target t
	WHERE EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = t.oid AND NOT g.tgisinternal)
UNION ALL
SELECT 'sequence' FROM target t
	WHERE EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attidentity <> '')
		OR EXISTS (SELECT 1 FROM pg_attrdef d WHERE d.adrelid = t.oid AND pg_get_expr(d.adbin, d.adrelid) LIKE '%nextval(%')
UNION ALL
SELECT 'policy' FROM target t
	WHERE t.relrowsecurity OR EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = t.oid)
UNION ALL
SELECT 'grant' FROM target t
	WHERE t.relacl IS NOT NULL
		OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attnum > 0 AND a.attacl IS NOT NULL)
UNION ALL
SELECT 'owner' FROM target t
	WHERE t.relowner <> (SELECT r.oid FROM pg_roles r WHERE r.rolname = current_user)
UNION ALL
SELECT 'publication' FROM target t
	WHERE EXISTS (SELECT 1 FROM pg_publication_rel r WHERE r.prrelid = t.oid)
		OR EXISTS (SELECT 1 FROM pg_publication p WHERE p.puballtables)%SCHEMA_PUBLICATIONS%
UNION ALL
SELECT 'dataset' FROM target t
	WHERE EXISTS (SELECT 1 FROM %DATASETS% d WHERE d.dataset = $2::text)
`;

/**
 * A table can also be published through its schema, from PostgreSQL 15. The
 * catalog that records it does not exist before then, and a statement that
 * names a missing catalog does not parse — so the clause is added only on a
 * server that has it.
 *
 * The catalogs are read directly rather than through `pg_publication_tables`:
 * that view resolves every publication by name as it goes, and fails with
 * "publication does not exist" when another session drops one meanwhile.
 */
const SCHEMA_PUBLICATIONS =
	"\n\t\tOR EXISTS (SELECT 1 FROM pg_publication_namespace s WHERE s.pnnspid = t.relnamespace)";

/** Columns a plain INSERT may name: live, and not generated. */
const COPYABLE_COLUMNS = `
SELECT a.attname::text AS name
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1::text AND c.relname = $2::text
	AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
ORDER BY a.attnum
`;

interface SnapshotTable {
	readonly name: string;
	/** False when the table did not exist when the snapshot was taken. */
	readonly present: boolean;
}

function parseSnapshotTables(text: string): readonly SnapshotTable[] {
	const parsed = parseJsonText(text);
	if (!Array.isArray(parsed)) return [];
	const out: SnapshotTable[] = [];
	for (const entry of parsed) {
		if (isPlainObject(entry) && isText(entry.name)) {
			out.push({ name: entry.name, present: entry.present === true });
		}
	}
	return out;
}

export interface SchemaPortOptions {
	readonly store: DatasetStore;
	/** Tables, in the binding's namespace, that snapshot and restore cover. */
	readonly tables: readonly string[];
	readonly clock: () => string;
}

export interface PostgresSchemaPort extends SchemaApplyPort {
	/** Drop one snapshot's copy. Snapshots are kept until dropped. */
	dropSnapshot(ref: SchemaSnapshotRef): Promise<void>;
	/** Drop every snapshot this namespace holds. */
	dropAllSnapshots(): Promise<void>;
}

export function createSchemaPort(
	options: SchemaPortOptions,
): PostgresSchemaPort {
	const { store, tables, clock } = options;
	const { executor, namespace } = store;
	const registry = store.meta("schemaSnapshots");
	let preflightText: Promise<string> | undefined;
	const preflight = (on: PostgresExecutor): Promise<string> => {
		preflightText ??= on
			.query(
				"SELECT (to_regclass('pg_catalog.pg_publication_namespace') IS NOT NULL)::text AS present",
			)
			.then((found) =>
				PREFLIGHT.replace("%DATASETS%", store.meta("datasets")).replace(
					"%SCHEMA_PUBLICATIONS%",
					found.rows[0]?.present === "true" ? SCHEMA_PUBLICATIONS : "",
				),
			)
			.catch((cause) => {
				preflightText = undefined;
				throw cause;
			});
		return preflightText;
	};

	/**
	 * Statements in a phase resolve unqualified names in the namespace first.
	 * `public` stays on the path behind it, because that is where extension
	 * types and functions a migration may name usually live.
	 */
	const inNamespace = async (tx: PostgresExecutor): Promise<void> => {
		await tx.query(
			"SELECT set_config('search_path', $1::text, true) AS search_path",
			[
				namespace === "public"
					? quoteIdentifier(namespace)
					: `${quoteIdentifier(namespace)}, public`,
			],
		);
	};

	const exists = async (
		on: PostgresExecutor,
		schema: string,
		table: string,
	): Promise<boolean> => {
		const found = await on.query(
			"SELECT c.relname::text AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1::text AND c.relname = $2::text",
			[schema, table],
		);
		return found.rows.length > 0;
	};

	/** Recreate `target` as a structural and data copy of `source`. */
	const copyTable = async (
		tx: PostgresExecutor,
		source: { readonly schema: string; readonly table: string },
		target: { readonly schema: string; readonly table: string },
	): Promise<void> => {
		const from = qualifiedName(source.schema, source.table);
		const into = qualifiedName(target.schema, target.table);
		await tx.query(`CREATE TABLE ${into} (LIKE ${from} INCLUDING ALL)`);
		const columns = await tx.query(COPYABLE_COLUMNS, [
			source.schema,
			source.table,
		]);
		const list = columns.rows
			.map((row) => quoteIdentifier(row.name ?? ""))
			.join(", ");
		if (list !== "") {
			await tx.query(
				`INSERT INTO ${into} (${list}) SELECT ${list} FROM ${from}`,
			);
		}
	};

	const dropSnapshot = async (ref: SchemaSnapshotRef): Promise<void> => {
		await store.ready();
		await executor.transaction(async (tx) => {
			const known = await tx.query(
				`DELETE FROM ${registry} WHERE snapshot_ref = $1::text RETURNING snapshot_ref`,
				[ref.ref],
			);
			// Only a schema this registry recorded is ever dropped.
			if (known.rows.length > 0) {
				await tx.query(
					`DROP SCHEMA IF EXISTS ${quoteIdentifier(ref.ref)} CASCADE`,
				);
			}
		});
	};

	return {
		async snapshot(): Promise<SchemaSnapshotRef> {
			await store.ready();
			if (tables.length === 0) {
				throw refusedPlan(
					"the schema port has no tables configured, so a snapshot could not restore anything; refusing to pretend otherwise",
					"",
				);
			}
			const ref = snapshotNamespace(
				namespace,
				randomUUID().replaceAll("-", "").slice(0, 16),
			);
			const takenAt = clock();
			await executor.transaction(async (tx) => {
				// One snapshot across every table copied.
				await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
				await tx.query(`CREATE SCHEMA ${quoteIdentifier(ref)}`);
				const recorded: SnapshotTable[] = [];
				for (const table of tables) {
					const present = await exists(tx, namespace, table);
					if (present) {
						const reasons = await tx.query(await preflight(tx), [
							namespace,
							table,
						]);
						const reason = reasons.rows[0]?.reason;
						if (reason !== null && reason !== undefined) {
							throw refusedPlan(
								`table ${table} cannot be snapshotted by copy — ${refusalText(reason)}`,
								table,
							);
						}
						await copyTable(
							tx,
							{ schema: namespace, table },
							{ schema: ref, table },
						);
					}
					recorded.push({ name: table, present });
				}
				await tx.query(
					`INSERT INTO ${registry} (snapshot_ref, taken_at, tables_json) VALUES ($1::text, $2::text, $3::text)`,
					[ref, takenAt, JSON.stringify(recorded)],
				);
			});
			return Object.freeze({ ref, takenAt });
		},

		async applyPhase(
			phase: SchemaPhase,
			statements: readonly string[],
		): Promise<SchemaPhaseResult> {
			await store.ready();
			if (statements.length === 0) {
				return Object.freeze({ phase, statements: 0, changes: 0 });
			}
			const changes = await executor.transaction(async (tx) => {
				await inNamespace(tx);
				let total = 0;
				for (const statement of statements) {
					total += (await tx.query(statement)).rowCount;
				}
				return total;
			});
			return Object.freeze({ phase, statements: statements.length, changes });
		},

		async verify(violationsQuery: string): Promise<readonly JsonObject[]> {
			await store.ready();
			const query = violationsQuery.trim().replace(/;+$/u, "");
			// Each row comes back as one JSON document, so evidence has the
			// same form whatever types the query selected.
			const result = await executor.transaction(async (tx) => {
				await inNamespace(tx);
				return tx.query(
					`SELECT to_jsonb(violation)::text AS violation FROM (${query}) AS violation`,
				);
			});
			const out: JsonObject[] = [];
			for (const row of result.rows) {
				const parsed = parseJsonText(row.violation ?? "null");
				if (isPlainObject(parsed)) out.push(parsed);
			}
			return Object.freeze(out);
		},

		async restore(ref: SchemaSnapshotRef): Promise<void> {
			await store.ready();
			await executor.transaction(async (tx) => {
				const known = await tx.query(
					`SELECT tables_json FROM ${registry} WHERE snapshot_ref = $1::text`,
					[ref.ref],
				);
				const text = known.rows[0]?.tables_json;
				if (text === null || text === undefined) {
					throw refusedPlan(
						`snapshot ${ref.ref} is missing; cannot restore`,
						"",
					);
				}
				for (const table of parseSnapshotTables(text)) {
					// No CASCADE: something that came to depend on the table
					// since the snapshot fails the restore loudly instead of
					// being dropped with it.
					await tx.query(
						`DROP TABLE IF EXISTS ${qualifiedName(namespace, table.name)}`,
					);
					if (table.present) {
						await copyTable(
							tx,
							{ schema: ref.ref, table: table.name },
							{ schema: namespace, table: table.name },
						);
					}
				}
			});
		},

		dropSnapshot,

		async dropAllSnapshots(): Promise<void> {
			await store.ready();
			const all = await executor.query(
				`SELECT snapshot_ref, taken_at FROM ${registry}`,
			);
			for (const row of all.rows) {
				if (row.snapshot_ref !== null && row.snapshot_ref !== undefined) {
					await dropSnapshot({
						ref: row.snapshot_ref,
						takenAt: row.taken_at ?? "",
					});
				}
			}
		},
	};
}
