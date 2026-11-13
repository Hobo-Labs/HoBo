/**
 * The fleet's own tables, created on every backend.
 *
 * Three small tables, all under the layout's control prefix so replication
 * never copies them: the assignment log (with the nullable `members` column of
 * membership epochs), the standby's watermark, and the per-period usage
 * counters. Creation is serialised by an advisory lock
 * because concurrent `CREATE TABLE IF NOT EXISTS` statements can still collide
 * in the catalog.
 */
import { FLEET_LOCK_CLASS, type FleetLayout } from "./layout.js";
import { inTransaction, type PostgresBackend } from "./sql.js";

/** Create the control tables on one backend. Safe to repeat and to race. */
export async function ensureFleetControlTables(
	backend: PostgresBackend,
	layout: FleetLayout,
): Promise<void> {
	await inTransaction(backend.executor, "BEGIN", async (session) => {
		await session.query(
			"SELECT pg_advisory_xact_lock($1::int, hashtext($2))::text AS locked",
			[FLEET_LOCK_CLASS, `${layout.controlPrefix}ddl`],
		);
		await session.query(`CREATE TABLE IF NOT EXISTS ${layout.assignmentTable} (
			epoch bigint PRIMARY KEY CHECK (epoch >= 1),
			active text,
			sealed boolean NOT NULL,
			target text,
			reason text NOT NULL,
			loss_window_ms bigint CHECK (loss_window_ms >= 0),
			decided_at timestamptz NOT NULL,
			decided_by text NOT NULL,
			members text[],
			CHECK (sealed = (target IS NOT NULL)),
			CHECK (target IS DISTINCT FROM active)
		)`);
		// A log created before member sets existed gains the column; every row
		// it already holds keeps a null set, which the configured members decide.
		await session.query(
			`ALTER TABLE ${layout.assignmentTable} ADD COLUMN IF NOT EXISTS members text[]`,
		);
		await session.query(`CREATE TABLE IF NOT EXISTS ${layout.watermarkTable} (
			singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
			source text NOT NULL,
			source_epoch bigint NOT NULL CHECK (source_epoch >= 1),
			snapshot_at timestamptz NOT NULL,
			tables jsonb NOT NULL,
			row_count bigint NOT NULL CHECK (row_count >= 0),
			byte_count bigint NOT NULL CHECK (byte_count >= 0),
			digest text NOT NULL,
			replicated_at timestamptz NOT NULL
		)`);
		await session.query(`CREATE TABLE IF NOT EXISTS ${layout.usageTable} (
			period text NOT NULL,
			unit text NOT NULL,
			used bigint NOT NULL CHECK (used >= 0),
			updated_at timestamptz NOT NULL,
			PRIMARY KEY (period, unit)
		)`);
	});
}
