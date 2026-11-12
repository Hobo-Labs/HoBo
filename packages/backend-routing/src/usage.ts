/**
 * Billing periods and the units an allowance is stated in.
 *
 * A plan's allowance is spent by use, and a provider's dashboard is not
 * something a scheduled job can read, so a host counts what it sends and adds
 * the count to a per-period counter. "Units used this month" is then a
 * measurement a policy can project from. How a host keeps the counter is its
 * own business (a table on each SQL backend, a key on each cache).
 */
import { BackendFleetError } from "./errors.js";

/**
 * The units an allowance, and therefore a measurement, can be stated in.
 *
 * `operations` is one statement sent to a SQL backend; `commands` one command
 * to a Redis-protocol store; `rows-read` and `rows-written` the rows a libSQL
 * database bills; `simple-operations` and `advanced-operations` the classes an
 * object store such as Vercel Blob bills. `storage-bytes` is a level, not a
 * rate.
 */
export const FLEET_USAGE_UNITS = [
	"operations",
	"compute-hours",
	"storage-bytes",
	"commands",
	"rows-read",
	"rows-written",
	"simple-operations",
	"advanced-operations",
] as const;

export type FleetUsageUnit = (typeof FLEET_USAGE_UNITS)[number];

/** Units measured as a level (a size), not as a rate over the period. */
export const FLEET_LEVEL_UNITS: readonly FleetUsageUnit[] = Object.freeze([
	"storage-bytes",
]);

export function parseFleetUsageUnit(value: string): FleetUsageUnit {
	const unit = FLEET_USAGE_UNITS.find((candidate) => candidate === value);
	if (unit === undefined)
		throw new BackendFleetError(
			"FLEET_RECORD_INVALID",
			"usage carries an unknown unit",
		);
	return unit;
}

export type BillingPeriod = {
	/** `YYYY-MM` of the UTC calendar month. */
	readonly id: string;
	readonly startsAtMs: number;
	readonly endsAtMs: number;
};

/** The UTC calendar month containing `nowMs`. */
export function billingPeriod(nowMs: number): BillingPeriod {
	if (!Number.isSafeInteger(nowMs) || nowMs < 0)
		throw new BackendFleetError(
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

// domain-view: a measurement with the unit as its parsed string union; the generated FleetUsageMeasurement in backend_fleet_pb.ts is its wire form.
export type FleetUsageMeasurement = {
	readonly unit: FleetUsageUnit;
	/** Measured use: this period's total for a rate, the current size for a level. */
	readonly used: number;
};
