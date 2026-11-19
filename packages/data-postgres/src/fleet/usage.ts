import {
	billingPeriod,
	FLEET_USAGE_UNITS,
	type FleetUsageUnit,
} from "@hobo/backend-fleet";
import { isJsonString } from "@hobo/data-core";
import { PostgresDataError } from "../errors.js";
import type { FleetLayout } from "./layout.js";
import { column, type FleetBackend, inTransaction, parseCount } from "./sql.js";

export {
	type BillingPeriod,
	billingPeriod,
	FLEET_USAGE_UNITS,
	type FleetUsageUnit,
} from "@hobo/backend-fleet";

export type PostgresFleetUsage = {
	readonly period: string;
	readonly unit: FleetUsageUnit;
	readonly used: number;
};

function parseUnit(value: string): FleetUsageUnit {
	const unit = FLEET_USAGE_UNITS.find((candidate) => candidate === value);
	if (unit === undefined)
		throw new PostgresDataError(
			"FLEET_RECORD_INVALID",
			"usage row carries an unknown unit",
		);
	return unit;
}

export type PostgresFleetUsageObservation = {
	readonly observationId: string;
	readonly observedAtMs: number;
	readonly statements: number;
};

export async function recordUsage(
	backend: FleetBackend,
	layout: FleetLayout,
	observation: PostgresFleetUsageObservation,
): Promise<"recorded" | "duplicate"> {
	const { observationId, observedAtMs, statements } = observation;
	if (
		!isJsonString(observationId) ||
		!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/u.test(observationId) ||
		!Number.isSafeInteger(statements) ||
		statements < 0
	) {
		throw new PostgresDataError(
			"FLEET_RECORD_INVALID",
			"usage needs an observation id and a non-negative integer count",
		);
	}
	const period = billingPeriod(observedAtMs).id;
	return inTransaction(
		backend.executor,
		"BEGIN ISOLATION LEVEL READ COMMITTED",
		async (session) => {
			const inserted = await session.query(
				`INSERT INTO ${layout.usageObservationsTable} (observation_id, observed_at_ms, period, unit, used)
			VALUES ($1::text, $2::bigint, $3::text, $4::text, $5::bigint)
			ON CONFLICT (observation_id) DO NOTHING RETURNING observation_id::text AS observation_id`,
				[observationId, observedAtMs, period, "operations", statements],
			);
			if (inserted.rows.length === 0) {
				const previous = await session.query(
					`SELECT observed_at_ms::text AS observed_at_ms, period, unit, used::text AS used FROM ${layout.usageObservationsTable}
				WHERE observation_id = $1::text`,
					[observationId],
				);
				const row = previous.rows[0];
				if (
					!row ||
					parseCount(column(row, "observed_at_ms"), "observed_at_ms") !==
						observedAtMs ||
					column(row, "period") !== period ||
					column(row, "unit") !== "operations" ||
					parseCount(column(row, "used"), "used") !== statements
				) {
					throw new PostgresDataError(
						"FLEET_RECORD_INVALID",
						"usage observation id was reused with different data",
					);
				}
				return "duplicate";
			}
			if (statements > 0) {
				const updated = await session.query(
					`INSERT INTO ${layout.usageTable} (period, unit, used, updated_at)
				VALUES ($1::text, $2::text, $3::bigint, clock_timestamp())
				ON CONFLICT (period, unit) DO UPDATE
				SET used = ${layout.usageTable}.used + EXCLUDED.used, updated_at = EXCLUDED.updated_at
				WHERE ${layout.usageTable}.used <= 9007199254740991 - EXCLUDED.used
				RETURNING used::text AS used`,
					[period, "operations", statements],
				);
				if (updated.rows.length !== 1)
					throw new PostgresDataError(
						"FLEET_RECORD_INVALID",
						"usage exceeds the safe integer range",
					);
			}
			return "recorded";
		},
	);
}

export async function readUsage(
	backend: FleetBackend,
	layout: FleetLayout,
	period: string,
): Promise<readonly PostgresFleetUsage[]> {
	const result = await backend.executor.query(
		`SELECT period, unit, used::text AS used FROM ${layout.usageTable}
		WHERE period = $1::text ORDER BY unit`,
		[period],
	);
	return result.rows.map((row) => ({
		period: column(row, "period"),
		unit: parseUnit(column(row, "unit")),
		used: parseCount(column(row, "used"), "used"),
	}));
}

export async function measureStorageBytes(
	backend: FleetBackend,
): Promise<number> {
	const result = await backend.executor.query(
		"SELECT pg_database_size(current_database())::text AS bytes",
	);
	return parseCount(column(result.rows[0] ?? {}, "bytes"), "bytes");
}
