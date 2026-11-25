import { PostgresDataError } from "../errors.js";
import { parseFleetIdentifier } from "./sql.js";

export type FleetLayoutInput = {
	readonly dataPrefix: string;
	readonly controlPrefix: string;
	readonly excludedTables?: readonly string[];
};

export type FleetLayout = {
	readonly dataPrefix: string;
	readonly controlPrefix: string;
	readonly excludedTables: readonly string[];
	readonly assignmentTable: string;
	readonly watermarkTable: string;
	readonly usageTable: string;
};

export const FLEET_LOCK_CLASS = 1_212_112_710;

export function parseFleetLayout(input: FleetLayoutInput): FleetLayout {
	const dataPrefix =
		input.dataPrefix === ""
			? ""
			: parseFleetIdentifier(input.dataPrefix, "dataPrefix");
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

export function isReplicatedTable(layout: FleetLayout, table: string): boolean {
	return (
		table.startsWith(layout.dataPrefix) &&
		!table.startsWith(layout.controlPrefix) &&
		!layout.excludedTables.includes(table)
	);
}
