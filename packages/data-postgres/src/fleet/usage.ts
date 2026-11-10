/**
 * Usage metering: what a host actually sent to each backend this period.
 *
 * A plan's allowance is spent by use, and a provider's dashboard is not
 * something a scheduled job can read. So the host counts what it sends (one
 * statement is one operation) and adds the count to a per-period row on the
 * backend the statements went to. "Operations used this month" is then a
 * measurement the policy can project from, not an estimate.
 *
 * The count is a lower bound. An instance that is stopped before it flushes
 * loses what it had not yet written; a host bounds that by flushing often.
 */
import { PostgresDataError } from "../errors.js";
import type { FleetLayout } from "./layout.js";
import { column, type FleetBackend, parseCount } from "./sql.js";

/** The units an allowance, and therefore a measurement, can be stated in. */
export const FLEET_USAGE_UNITS = [
	"operations",
	"compute-hours",
	"storage-bytes",
] as const;

export type FleetUsageUnit = (typeof FLEET_USAGE_UNITS)[number];

export type BillingPeriod = {
	/** `YYYY-MM` of the UTC calendar month. */
	readonly id: string;
	readonly startsAtMs: number;
	readonly endsAtMs: number;
};

/** The UTC calendar month containing `nowMs`. */
export function billingPeriod(nowMs: number): BillingPeriod {
	if (!Number.isSafeInteger(nowMs) || nowMs < 0)
		throw new PostgresDataError(
			"FLEET_RECORD_INVALID",
			"a billing period needs a non-negative instant",
		);
	const now = new Date(nowMs);
	const year = now.getUTCFullYear();
	const month = now.getUTCMonth();
	return {
		id: `${year}-${String(month + 1).padStart(2, "0")}`,
		startsAtMs: Date.UTC(year, month, 1),
		endsAtMs: Date.UTC(year, month + 1, 1),
	};
}

// parallel-type-allowed: the parsed in-process measurement read back through readUsage; the proto PostgresFleetUsage is its wire projection.
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

/** Add `amount` to a backend's counter for one period and unit. */
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

/** A backend's counters for one period. */
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

/** The size of the backend's database, the measurement for a storage allowance. */
export async function measureStorageBytes(
	backend: FleetBackend,
): Promise<number> {
	const result = await backend.executor.query(
		"SELECT pg_database_size(current_database())::text AS bytes",
	);
	return parseCount(column(result.rows[0] ?? {}, "bytes"), "bytes");
}

export type UsageMeter = {
	/** Count statements sent to one backend. */
	record(backendId: string, statements?: number): void;
	/** Statements counted and not yet written for one backend. */
	pending(backendId: string): number;
	/** Write every backend's pending count to that backend, keeping what fails. */
	flush(
		backends: readonly FleetBackend[],
		layout: FleetLayout,
		nowMs: number,
	): Promise<void>;
};

/**
 * In-memory statement counters, written out by `flush`. A backend that cannot
 * be reached keeps its count for the next flush; nothing is dropped and
 * nothing is counted twice.
 */
export function createUsageMeter(): UsageMeter {
	const counts = new Map<string, number>();
	return {
		record(backendId, statements = 1) {
			counts.set(backendId, (counts.get(backendId) ?? 0) + statements);
		},
		pending(backendId) {
			return counts.get(backendId) ?? 0;
		},
		async flush(backends, layout, nowMs) {
			const period = billingPeriod(nowMs).id;
			await Promise.all(
				backends.map(async (backend) => {
					const used = counts.get(backend.id) ?? 0;
					if (used === 0) return;
					counts.set(backend.id, 0);
					try {
						await addUsage(backend, layout, {
							period,
							unit: "operations",
							used,
						});
					} catch {
						counts.set(backend.id, (counts.get(backend.id) ?? 0) + used);
					}
				}),
			);
		},
	};
}
