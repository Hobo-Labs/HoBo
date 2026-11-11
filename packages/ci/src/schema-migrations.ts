/**
 * Applies a package's checked-in migrations and records what ran.
 *
 * This is the one runner. `pnpm run db:migrate` calls it for an operator, the
 * schema tests call it against scratch databases, and a host calls it at run
 * time with the migration sets the packages ship (`schemaMigrations`, embedded
 * from `db/migrations/` and held to it by `db:check`), so every database a
 * relay prepares gets its schema from the same reviewed SQL.
 *
 * One run is one transaction. It takes the migration lock, then the advisory
 * locks the package's embedded initialisation takes (so a function instance
 * initialising its store cannot interleave with the migration), creates the
 * ledger table if this is the first run against the database, and walks the
 * journal in order:
 *
 * - a migration the ledger already holds is skipped, after checking the ledger
 *   recorded the same SQL digest the journal carries now;
 * - a pending migration has its statements executed, then its violations
 *   query. Any violation rolls the whole run back. Nothing is recorded for a
 *   database the migration did not actually converge.
 *
 * A database whose ledger holds a migration this set does not have is ahead of
 * this code. It is refused before any statement runs and left as it is: there
 * is no downgrade.
 *
 * Every statement is guarded, so the baseline can be applied to an empty
 * database, to one the embedded DDL fully initialised, and to one where only
 * some stores have initialised so far; it creates what is missing and leaves
 * existing tables and their rows alone. Running it again is a no-op, and two
 * runs at once apply once: the second waits at the lock and finds the ledger.
 */

import type { Pool } from "pg";

/** Where applied migrations are recorded, for every scope. */
// public-contract: the relay's migration ledger table, named in operator docs and excluded from fleet replication by name.
export const SCHEMA_LEDGER_TABLE = "hobo_ci_schema_migrations";
const MIGRATION_LOCK = "hobo-ci-schema-migrations";

export class SchemaMigrationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SchemaMigrationError";
	}
}

/**
 * The database records migrations this code does not have. Nothing was run,
 * and nothing is removed: a newer release owns that schema.
 */
export class SchemaAheadError extends SchemaMigrationError {
	constructor(
		readonly scope: string,
		/** The recorded migrations this code does not know, in ledger order. */
		readonly unknown: readonly string[],
	) {
		super(
			`${scope}: the database records migrations this checkout does not have (${unknown.join(", ")}); it is ahead of this code`,
		);
		this.name = "SchemaAheadError";
	}
}

/** One migration, loaded and digest-checked: exactly what the runner applies. */
export interface SchemaMigration {
	readonly id: string;
	readonly statements: readonly string[];
	readonly sqlSha256: string;
	readonly planDigest: string;
	readonly engine: string;
	readonly violationsQuery: string;
}

/** One package's migrations, in journal order, and the locks they run under. */
export interface SchemaMigrationSet {
	readonly scope: string;
	readonly advisoryLocks: readonly string[];
	readonly migrations: readonly SchemaMigration[];
}

export interface AppliedMigrations {
	readonly scope: string;
	readonly applied: readonly string[];
	readonly alreadyApplied: readonly string[];
}

interface LedgerRow {
	readonly id: string;
	readonly sql_sha256: string;
}

interface Violation {
	readonly object: string;
	readonly name: string;
	readonly problem: string;
}

/** The first SQL line of a statement, skipping the `-- step:` comments. */
function statementSummary(statement: string): string {
	return (
		statement
			.split("\n")
			.find((line) => line.length > 0 && !line.startsWith("--")) ?? statement
	);
}

export async function applyMigrations(
	pool: Pool,
	set: SchemaMigrationSet,
): Promise<AppliedMigrations> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		for (const lock of [MIGRATION_LOCK, ...set.advisoryLocks])
			await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lock]);
		await client.query(
			`CREATE TABLE IF NOT EXISTS ${SCHEMA_LEDGER_TABLE} (scope text NOT NULL, id text NOT NULL, sql_sha256 text NOT NULL, plan_digest text NOT NULL, engine text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (scope, id))`,
		);
		const ledger = await client.query<LedgerRow>(
			`SELECT id, sql_sha256 FROM ${SCHEMA_LEDGER_TABLE} WHERE scope = $1 ORDER BY id`,
			[set.scope],
		);
		const recorded = new Map(
			ledger.rows.map((row) => [row.id, row.sql_sha256]),
		);
		const known = new Set(set.migrations.map((migration) => migration.id));
		const unknown = [...recorded.keys()].filter((id) => !known.has(id));
		if (unknown.length > 0) throw new SchemaAheadError(set.scope, unknown);

		const applied: string[] = [];
		const alreadyApplied: string[] = [];
		for (const migration of set.migrations) {
			const digest = recorded.get(migration.id);
			if (digest !== undefined) {
				if (digest !== migration.sqlSha256)
					throw new SchemaMigrationError(
						`${set.scope}: ${migration.id} was applied with different SQL than the journal now holds`,
					);
				if (applied.length > 0)
					throw new SchemaMigrationError(
						`${set.scope}: ${migration.id} is recorded but an earlier migration (${applied.join(", ")}) is not`,
					);
				alreadyApplied.push(migration.id);
				continue;
			}
			for (const statement of migration.statements) {
				try {
					await client.query(statement);
				} catch (error) {
					throw new SchemaMigrationError(
						`${set.scope}: ${migration.id} failed and was rolled back; nothing was recorded. ${error instanceof Error ? error.message : "unknown error"} (in: ${statementSummary(statement)})`,
					);
				}
			}
			const violations = await client.query<Violation>(
				migration.violationsQuery,
			);
			if (violations.rows.length > 0)
				throw new SchemaMigrationError(
					`${set.scope}: ${migration.id} did not converge; nothing was recorded. ${violations.rows
						.map((row) => `${row.object} ${row.name}: ${row.problem}`)
						.join("; ")}`,
				);
			await client.query(
				`INSERT INTO ${SCHEMA_LEDGER_TABLE} (scope, id, sql_sha256, plan_digest, engine) VALUES ($1, $2, $3, $4, $5)`,
				[
					set.scope,
					migration.id,
					migration.sqlSha256,
					migration.planDigest,
					migration.engine,
				],
			);
			applied.push(migration.id);
		}
		await client.query("COMMIT");
		return { scope: set.scope, applied, alreadyApplied };
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

/** What a database's ledger says about some migration sets. */
export type SchemaLedgerState =
	| { readonly status: "current" }
	| { readonly status: "behind" }
	| {
			readonly status: "ahead";
			readonly scope: string;
			readonly unknown: readonly string[];
	  };

interface RecordedRow {
	readonly scope: string;
	readonly id: string;
	readonly sql_sha256: string;
}

/**
 * Whether a database already holds every migration of `sets`, read from its
 * ledger in one statement and changing nothing. `current` means a run of
 * `applyMigrations` would apply nothing; `behind` means it has work to do, or
 * a recorded digest to object to; `ahead` means the ledger holds a migration
 * these sets do not have, which `applyMigrations` refuses.
 *
 * A caller that prepares many databases often asks this first, so that a
 * database already in place costs one read and no lock.
 */
export async function readSchemaLedger(
	pool: Pick<Pool, "query">,
	sets: readonly SchemaMigrationSet[],
): Promise<SchemaLedgerState> {
	let rows: readonly RecordedRow[];
	try {
		rows = (
			await pool.query<RecordedRow>(
				`SELECT scope, id, sql_sha256 FROM ${SCHEMA_LEDGER_TABLE} WHERE scope = ANY($1::text[]) ORDER BY scope, id`,
				[sets.map((set) => set.scope)],
			)
		).rows;
	} catch (error) {
		// No ledger yet: nothing has been migrated here.
		if (error instanceof Error && "code" in error && error.code === "42P01")
			return { status: "behind" };
		throw error;
	}
	let behind = false;
	for (const set of sets) {
		const recorded = new Map(
			rows
				.filter((row) => row.scope === set.scope)
				.map((row) => [row.id, row.sql_sha256]),
		);
		const known = new Set(set.migrations.map((migration) => migration.id));
		const unknown = [...recorded.keys()].filter((id) => !known.has(id));
		if (unknown.length > 0)
			return { status: "ahead", scope: set.scope, unknown };
		if (
			set.migrations.some(
				(migration) => recorded.get(migration.id) !== migration.sqlSha256,
			)
		)
			behind = true;
	}
	return behind ? { status: "behind" } : { status: "current" };
}

/** `@hobo/ci`'s own migrations: the tables `PostgresCiStore` owns. */
export { schemaMigrations as ciSchemaMigrations } from "./_generated-assets/schema-migrations.js";
