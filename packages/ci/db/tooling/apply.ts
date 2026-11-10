/**
 * Applies a package's checked-in migrations and records what ran.
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
 * Every statement is guarded, so the baseline can be applied to an empty
 * database, to one the embedded DDL fully initialised, and to one where only
 * some stores have initialised so far; it creates what is missing and leaves
 * existing tables and their rows alone. Running it again is a no-op.
 */

import type { Pool } from "pg";
import { type MigrationSet, SchemaMigrationError } from "./journal.js";

/** Where applied migrations are recorded, for every scope. */
export const SCHEMA_LEDGER_TABLE = "hobo_ci_schema_migrations";
const MIGRATION_LOCK = "hobo-ci-schema-migrations";

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
	set: MigrationSet,
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
		if (unknown.length > 0)
			throw new SchemaMigrationError(
				`${set.scope}: the database records migrations this checkout does not have (${unknown.join(", ")}); it is ahead of this code`,
			);

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
