/**
 * The equivalence proof, on a real PostgreSQL.
 *
 * Three scratch databases are created next to the one the connection URL names
 * and dropped afterwards:
 *
 * - `embedded`: built by the stores' own initialisation code, unchanged;
 * - `migrated`: an empty database with the checked-in migrations applied;
 * - `existing`: built by the initialisation code, given a row in every table,
 *   and then migrated — the state every deployed database is in.
 *
 * The proof holds when the catalogs of `embedded` and `migrated` are identical
 * apart from the migration ledger; when migrating `existing` changes neither
 * its catalog nor a single row; and when a second run of the migrations on any
 * of them applies nothing.
 *
 * Separate databases rather than schemas, deliberately: the embedded DDL looks
 * some objects up by name alone (`pg_constraint` by `conname`), so two schemas
 * in one database would not be independent.
 */

import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { applyMigrations, SCHEMA_LEDGER_TABLE } from "./apply.js";
import {
	type CatalogFact,
	compareCatalogs,
	factsOutsideTable,
	readCatalog,
} from "./catalog.js";
import type { MigrationSet } from "./journal.js";

const EVERY_TABLE = "%";

export interface EquivalenceSubject {
	readonly migrations: MigrationSet;
	/** Runs the package's embedded DDL exactly as production does. */
	readonly initializeEmbedded: (pool: Pool) => Promise<void>;
}

export interface EquivalenceProof {
	readonly serverVersion: string;
	/** Catalog facts compared between `embedded` and `migrated`. */
	readonly factsCompared: number;
	/** `embedded` vs `migrated`, ledger excluded. Empty when equivalent. */
	readonly differences: readonly string[];
	/** `existing` before vs after migrating, ledger excluded. */
	readonly existingCatalogChanges: readonly string[];
	/** Tables whose rows changed when `existing` was migrated. */
	readonly existingDataChanges: readonly string[];
	readonly rowsPreserved: number;
	readonly appliedToEmpty: readonly string[];
	readonly appliedToExisting: readonly string[];
	/** Migrations a second run applied to `migrated` or `existing`. */
	readonly reapplied: readonly string[];
	/** Objects only the migrated databases have, and why that is expected. */
	readonly justified: readonly string[];
}

export interface ScratchDatabase {
	readonly name: string;
	readonly pool: Pool;
}

function databaseUrl(connectionUrl: string, database: string): string {
	const url = new URL(connectionUrl);
	url.pathname = `/${database}`;
	return url.toString();
}

/**
 * Creates the named scratch databases, runs `run`, and drops them whatever
 * happened. The connecting role needs CREATEDB.
 */
export async function withScratchDatabases<Result>(
	connectionUrl: string,
	labels: readonly string[],
	run: (databases: readonly ScratchDatabase[]) => Promise<Result>,
): Promise<Result> {
	const admin = new Pool({ connectionString: connectionUrl, max: 1 });
	const suffix = randomBytes(6).toString("hex");
	const databases: ScratchDatabase[] = [];
	try {
		for (const label of labels) {
			const name = `hobo_ci_schema_proof_${label}_${suffix}`;
			await admin.query(`CREATE DATABASE ${name}`);
			databases.push({
				name,
				pool: new Pool({
					connectionString: databaseUrl(connectionUrl, name),
					max: 4,
				}),
			});
		}
		return await run(databases);
	} finally {
		for (const database of databases) {
			await database.pool.end();
			await sessionsClosed(admin, database.name);
			await admin.query(`DROP DATABASE IF EXISTS ${database.name}`);
		}
		await admin.end();
	}
}

interface SessionCount {
	readonly sessions: string;
}

/**
 * `pool.end()` resolves once the pool has asked its clients to disconnect, not
 * once the server has seen them go. Dropping the database in that window either
 * fails or, with FORCE, kills a session whose client then reports an error
 * nothing is listening for. So wait for the server's own view to be empty.
 */
async function sessionsClosed(admin: Pool, database: string): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		const open = await admin.query<SessionCount>(
			"SELECT count(*)::text AS sessions FROM pg_catalog.pg_stat_activity WHERE datname = $1",
			[database],
		);
		if (open.rows[0]?.sessions === "0") return;
		await delay(10);
	}
	throw new Error(`sessions on ${database} did not close`);
}

interface ColumnRow {
	readonly table_name: string;
	readonly column_name: string;
	readonly type_name: string;
}

/** Text columns get JSON text: some are indexed through a `::jsonb` cast. */
const SAMPLE_VALUES = new Map([
	["text", "'{\"seed\":true}'"],
	["bigint", "7"],
	["integer", "7"],
	["boolean", "true"],
	["bytea", "'\\x01'::bytea"],
	["jsonb", "'{\"seed\":true}'::jsonb"],
	["uuid", "gen_random_uuid()"],
	["timestamp with time zone", "now()"],
]);

/**
 * Puts one row into every table, supplying each NOT NULL column that has no
 * default and letting defaults fill the rest, so the row is one the schema
 * itself accepts. Returns how many rows went in.
 */
async function seedEveryTable(
	pool: Pool,
	tables: readonly string[],
): Promise<number> {
	const required = await pool.query<ColumnRow>(
		`SELECT c.relname AS table_name, a.attname AS column_name,
			pg_catalog.format_type(a.atttypid, NULL) AS type_name
		FROM pg_catalog.pg_class c
		JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
		JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
		WHERE c.relkind = 'r' AND c.relname = ANY($1) AND a.attnotnull AND NOT a.atthasdef
		ORDER BY c.relname, a.attnum`,
		[tables],
	);
	let inserted = 0;
	for (const table of tables) {
		const columns = required.rows.filter((row) => row.table_name === table);
		const values = columns.map((column) => {
			const sample = SAMPLE_VALUES.get(column.type_name);
			if (sample === undefined)
				throw new Error(
					`no sample value for ${table}.${column.column_name} (${column.type_name})`,
				);
			return sample;
		});
		const result = await pool.query(
			columns.length === 0
				? `INSERT INTO ${table} DEFAULT VALUES ON CONFLICT DO NOTHING`
				: `INSERT INTO ${table} (${columns.map((c) => c.column_name).join(", ")}) VALUES (${values.join(", ")}) ON CONFLICT DO NOTHING`,
		);
		inserted += result.rowCount ?? 0;
	}
	return inserted;
}

interface TableDigest {
	readonly rows: string;
	readonly digest: string;
}

/** Row count and an order-independent digest of every row, per table. */
async function tableDigests(
	pool: Pool,
	tables: readonly string[],
): Promise<Map<string, string>> {
	const digests = new Map<string, string>();
	for (const table of tables) {
		const result = await pool.query<TableDigest>(
			`SELECT count(*)::text AS rows,
				md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest
			FROM ${table} t`,
		);
		const row = result.rows[0];
		digests.set(table, `${row?.rows ?? "?"} rows, md5 ${row?.digest ?? "?"}`);
	}
	return digests;
}

/** Every catalog fact in the database except the migration ledger's own. */
export async function schemaFacts(pool: Pool): Promise<CatalogFact[]> {
	return factsOutsideTable(
		await readCatalog(pool, EVERY_TABLE),
		SCHEMA_LEDGER_TABLE,
	);
}

function tableNames(facts: readonly CatalogFact[]): string[] {
	return facts.flatMap((fact) => {
		const name = /^table (\w+)$/u.exec(fact.subject)?.[1];
		return name === undefined ? [] : [name];
	});
}

interface VersionRow {
	readonly server_version: string;
}

export async function proveEquivalence(
	connectionUrl: string,
	subject: EquivalenceSubject,
): Promise<EquivalenceProof> {
	return withScratchDatabases(
		connectionUrl,
		["embedded", "migrated", "existing"],
		async ([embedded, migrated, existing]) => {
			if (!embedded || !migrated || !existing)
				throw new Error("scratch databases were not created");
			const version = await embedded.pool.query<VersionRow>(
				"SHOW server_version",
			);

			await subject.initializeEmbedded(embedded.pool);
			const embeddedFacts = await schemaFacts(embedded.pool);

			const emptyRun = await applyMigrations(migrated.pool, subject.migrations);
			const migratedFacts = await schemaFacts(migrated.pool);
			const ledgerFacts =
				(await readCatalog(migrated.pool, EVERY_TABLE)).length -
				migratedFacts.length;
			const emptyRerun = await applyMigrations(
				migrated.pool,
				subject.migrations,
			);

			await subject.initializeEmbedded(existing.pool);
			const tables = tableNames(await schemaFacts(existing.pool));
			const rowsPreserved = await seedEveryTable(existing.pool, tables);
			const factsBefore = await schemaFacts(existing.pool);
			const dataBefore = await tableDigests(existing.pool, tables);
			const existingRun = await applyMigrations(
				existing.pool,
				subject.migrations,
			);
			const factsAfter = await schemaFacts(existing.pool);
			const dataAfter = await tableDigests(existing.pool, tables);
			const existingRerun = await applyMigrations(
				existing.pool,
				subject.migrations,
			);

			return {
				serverVersion:
					version.rows[0]?.server_version.split(" ")[0] ?? "unknown",
				factsCompared: embeddedFacts.length,
				differences: compareCatalogs(
					{ label: "embedded DDL", facts: embeddedFacts },
					{ label: "migrations", facts: migratedFacts },
				),
				existingCatalogChanges: compareCatalogs(
					{ label: "before migrating", facts: factsBefore },
					{ label: "after migrating", facts: factsAfter },
				),
				existingDataChanges: tables.filter(
					(table) => dataBefore.get(table) !== dataAfter.get(table),
				),
				rowsPreserved,
				appliedToEmpty: emptyRun.applied,
				appliedToExisting: existingRun.applied,
				reapplied: [...emptyRerun.applied, ...existingRerun.applied],
				justified: [
					`${SCHEMA_LEDGER_TABLE} (${ledgerFacts} catalog facts) exists only where migrations ran: it is the ledger the runner creates to record them, and the embedded DDL has no counterpart.`,
				],
			};
		},
	);
}
