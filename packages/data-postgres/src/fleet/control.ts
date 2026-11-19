import { PostgresDataError } from "../errors.js";
import { FLEET_LOCK_CLASS, type FleetLayout } from "./layout.js";
import { type FleetBackend, inTransaction } from "./sql.js";

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
			epoch bigint PRIMARY KEY,
			active text,
			sealed boolean NOT NULL,
			target text,
			reason text NOT NULL,
			loss_window_ms bigint,
			decided_at timestamptz NOT NULL,
			decided_by text NOT NULL,
			CONSTRAINT assignment_epoch_positive CHECK (epoch >= 1),
			CONSTRAINT assignment_loss_nonnegative CHECK (loss_window_ms >= 0),
			CONSTRAINT assignment_sealed_target CHECK (sealed = (target IS NOT NULL)),
			CONSTRAINT assignment_distinct_target CHECK (NOT sealed OR target IS DISTINCT FROM active)
		)`);
		const constraints = await session.query(
			`SELECT conname::text AS name, pg_get_constraintdef(oid)::text AS definition,
			convalidated::text AS validated
			FROM pg_constraint WHERE conrelid = to_regclass($1) AND contype = 'c'`,
			[layout.assignmentTable],
		);
		const expected = new Map([
			["assignment_epoch_positive", "CHECK ((epoch >= 1))"],
			["assignment_loss_nonnegative", "CHECK ((loss_window_ms >= 0))"],
			["assignment_sealed_target", "CHECK ((sealed = (target IS NOT NULL)))"],
			[
				"assignment_distinct_target",
				"CHECK (((NOT sealed) OR (target IS DISTINCT FROM active)))",
			],
		]);
		if (
			constraints.rows.length !== expected.size ||
			constraints.rows.some(
				(row) =>
					row.validated !== "true" ||
					expected.get(row.name ?? "") !== row.definition,
			)
		) {
			throw new PostgresDataError(
				"FLEET_CONFIGURATION_INVALID",
				"fleet assignment constraints do not match the current schema",
			);
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
		await session.query(`CREATE TABLE IF NOT EXISTS ${layout.usageObservationsTable} (
			observation_id text PRIMARY KEY,
			observed_at_ms bigint NOT NULL CHECK (observed_at_ms >= 0),
			period text NOT NULL,
			unit text NOT NULL,
			used bigint NOT NULL CHECK (used >= 0)
		)`);
	});
}
