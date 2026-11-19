import {
	billingPeriod,
	FLEET_USAGE_UNITS,
	type FleetUsageUnit,
} from "@hobo/backend-fleet";
import { PostgresDataError } from "../errors.js";
import type { FleetLayout } from "./layout.js";
import { column, type FleetBackend, parseCount } from "./sql.js";

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

export async function addUsage(
	backend: FleetBackend,
	layout: FleetLayout,
	usage: PostgresFleetUsage,
): Promise<void> {
	if (!Number.isSafeInteger(usage.used) || usage.used < 0)
		throw new PostgresDataError(
			"FLEET_RECORD_INVALID",
			"usage must be a non-negative integer",
		);
	if (usage.used === 0) return;
	await backend.executor.query(
		`INSERT INTO ${layout.usageTable} (period, unit, used, updated_at)
		VALUES ($1::text, $2::text, $3::bigint, clock_timestamp())
		ON CONFLICT (period, unit) DO UPDATE
		SET used = ${layout.usageTable}.used + EXCLUDED.used, updated_at = EXCLUDED.updated_at`,
		[usage.period, usage.unit, usage.used],
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

export type UsageMeter = {
	record(backendId: string, atMs: number, statements?: number): void;
	pending(backendId: string, period: string): number;
	flush(backends: readonly FleetBackend[], layout: FleetLayout): Promise<void>;
};

export function createUsageMeter(): UsageMeter {
	const counts = new Map<string, Map<string, number>>();
	const inFlight = new Map<string, Map<string, number>>();
	function adjust(
		buckets: Map<string, Map<string, number>>,
		backendId: string,
		period: string,
		delta: number,
	): void {
		const periods = buckets.get(backendId) ?? new Map<string, number>();
		const next = (periods.get(period) ?? 0) + delta;
		if (next === 0) periods.delete(period);
		else periods.set(period, next);
		if (periods.size === 0) buckets.delete(backendId);
		else buckets.set(backendId, periods);
	}
	function pending(backendId: string, period: string): number {
		return (
			(counts.get(backendId)?.get(period) ?? 0) +
			(inFlight.get(backendId)?.get(period) ?? 0)
		);
	}
	return {
		record(backendId, atMs, statements = 1) {
			if (
				!backendId.trim() ||
				!Number.isSafeInteger(statements) ||
				statements < 0
			)
				throw new PostgresDataError(
					"FLEET_RECORD_INVALID",
					"usage needs a backend and a non-negative integer count",
				);
			const period = billingPeriod(atMs).id;
			if (!Number.isSafeInteger(pending(backendId, period) + statements))
				throw new PostgresDataError(
					"FLEET_RECORD_INVALID",
					"pending usage exceeds the safe integer range",
				);
			if (statements > 0) adjust(counts, backendId, period, statements);
		},
		pending,
		async flush(backends, layout) {
			await Promise.all(
				backends.flatMap((backend) =>
					[...(counts.get(backend.id) ?? [])].map(async ([period, used]) => {
						adjust(counts, backend.id, period, -used);
						adjust(inFlight, backend.id, period, used);
						try {
							await addUsage(backend, layout, {
								period,
								unit: "operations",
								used,
							});
						} catch {
							adjust(counts, backend.id, period, used);
						} finally {
							adjust(inFlight, backend.id, period, -used);
						}
					}),
				),
			);
		},
	};
}
