/**
 * Which tables belong to a fleet, parsed once.
 *
 * A fleet copies *data* tables from the writer to the standbys and keeps its
 * own *control* tables on every backend. The two sets must never overlap: a
 * control table that was copied would let one backend overwrite another
 * backend's view of who the writer is.
 */
import { PostgresDataError } from "../errors.js";
import { parseFleetIdentifier } from "./sql.js";

export type FleetLayoutInput = {
	/** Every table whose name starts with this belongs to the application. */
	readonly dataPrefix: string;
	/** Every table whose name starts with this belongs to the fleet. */
	readonly controlPrefix: string;
	/** Tables under `dataPrefix` that are not copied, e.g. migration bookkeeping. */
	readonly excludedTables?: readonly string[];
};

/** Parsed names. Every string here is a plain identifier safe to interpolate. */
export type FleetLayout = {
	readonly dataPrefix: string;
	readonly controlPrefix: string;
	readonly excludedTables: readonly string[];
	readonly assignmentTable: string;
	readonly watermarkTable: string;
	readonly usageTable: string;
};

/** Key class for the fleet's advisory locks, kept apart from single-key locks. */
export const FLEET_LOCK_CLASS = 1_212_112_710;

export function parseFleetLayout(input: FleetLayoutInput): FleetLayout {
	const dataPrefix = parseFleetIdentifier(input.dataPrefix, "dataPrefix");
	const controlPrefix = parseFleetIdentifier(
		input.controlPrefix,
		"controlPrefix",
	);
	if (controlPrefix.length > 40)
		throw new PostgresDataError(
			"FLEET_CONFIGURATION_INVALID",
			"controlPrefix leaves no room for a table name",
			{ detail: { field: "controlPrefix" } },
		);
	if (dataPrefix.startsWith(controlPrefix))
		throw new PostgresDataError(
			"FLEET_CONFIGURATION_INVALID",
			"controlPrefix must not cover the data tables",
			{ detail: { field: "controlPrefix" } },
		);
	const excludedTables = (input.excludedTables ?? []).map((name) =>
		parseFleetIdentifier(name, "excludedTables"),
	);
	return Object.freeze({
		dataPrefix,
		controlPrefix,
		excludedTables: Object.freeze([...new Set(excludedTables)].sort()),
		assignmentTable: `${controlPrefix}assignments`,
		watermarkTable: `${controlPrefix}watermarks`,
		usageTable: `${controlPrefix}usage`,
	});
}

/** True when `table` is copied from the writer to a standby. */
export function isReplicatedTable(layout: FleetLayout, table: string): boolean {
	return (
		table.startsWith(layout.dataPrefix) &&
		!table.startsWith(layout.controlPrefix) &&
		!layout.excludedTables.includes(table)
	);
}
