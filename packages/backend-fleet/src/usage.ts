import { BackendFleetError } from "./errors.js";

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
	readonly id: string;
	readonly startsAtMs: number;
	readonly endsAtMs: number;
};

export function billingPeriod(nowMs: number): BillingPeriod {
	if (!Number.isSafeInteger(nowMs) || nowMs < 0)
		throw new BackendFleetError(
			"FLEET_RECORD_INVALID",
			"a billing period needs a non-negative instant",
		);
	const now = new Date(nowMs);
	const year = now.getUTCFullYear();
	const month = now.getUTCMonth();
	if (year > 9999)
		throw new BackendFleetError(
			"FLEET_RECORD_INVALID",
			"a billing period must use a four-digit year",
		);
	const startsAtMs = Date.UTC(year, month, 1);
	const endsAtMs = Date.UTC(year, month + 1, 1);
	if (!Number.isFinite(startsAtMs) || !Number.isFinite(endsAtMs))
		throw new BackendFleetError(
			"FLEET_RECORD_INVALID",
			"a billing period needs a representable month",
		);
	return {
		id: `${year}-${String(month + 1).padStart(2, "0")}`,
		startsAtMs,
		endsAtMs,
	};
}

export type FleetUsageMeasurement = {
	readonly unit: FleetUsageUnit;
	readonly used: number;
};
