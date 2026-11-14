/**
 * The fleet's own tables, created on every backend.
 *
 * Three small tables, all under the layout's control prefix so replication
 * never copies them: the assignment log, the standby's watermark, and the
 * per-period usage counters. Creation is serialised by an advisory lock
 * because concurrent `CREATE TABLE IF NOT EXISTS` statements can still collide
 * in the catalog.
 */
import { FLEET_LOCK_CLASS, type FleetLayout } from "./layout.js";
import { type FleetBackend, inTransaction, quoteIdentifier } from "./sql.js";

/** Create the control tables on one backend. Safe to repeat and to race. */
export async function ensureFleetControlTables(
	backend: FleetBackend,
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
			CHECK (sealed = (target IS NOT NULL)),
			CHECK (NOT sealed OR target IS DISTINCT FROM active)
		)`);
		// Older fleets used `target IS DISTINCT FROM active` unconditionally.
		// It rejects the supported unsealed/no-writer state (both are NULL).
		// Replace only that exact old check, under the existing DDL lock and in
		// one transaction. Preserve all data and any unrelated constraints.
		const constraints = await session.query(
			`SELECT conname::text AS name, pg_get_constraintdef(oid)::text AS definition
			FROM pg_constraint WHERE conrelid = to_regclass($1) AND contype = 'c'`,
			[layout.assignmentTable],
		);
		const old = constraints.rows.filter(
			(row) => row.definition === "CHECK ((target IS DISTINCT FROM active))",
		);
		if (old.length > 0) {
			const replacement = `${layout.controlPrefix}assignment_target_guard`;
			const existing = constraints.rows.find((row) => row.name === replacement);
			if (
				existing &&
				existing.definition !==
					"CHECK (((NOT sealed) OR (target IS DISTINCT FROM active)))"
			)
				throw new Error("fleet assignment constraint name is already in use");
			if (!existing)
				await session.query(
					`ALTER TABLE ${layout.assignmentTable} ADD CONSTRAINT ${quoteIdentifier(replacement)} CHECK (NOT sealed OR target IS DISTINCT FROM active)`,
				);
			for (const row of old) {
				if (!row.name)
					throw new Error("fleet assignment constraint has no name");
				await session.query(
					`ALTER TABLE ${layout.assignmentTable} DROP CONSTRAINT ${quoteIdentifier(row.name)}`,
				);
			}
		}
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
