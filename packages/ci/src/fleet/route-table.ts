
import {
	balanceFleet,
	type FleetBalance,
	type FleetBalanceInput,
	type FleetDemand,
} from "./balance.js";

// public-contract: workflows read their runs-on label from this variable.
export const FLEET_ROUTES_VARIABLE = "HOBO_CI_FLEET_ROUTES";

export type FleetRouteClass = Readonly<{
	name: string;
	hoboLabel: string;
	demand: Omit<FleetDemand, "id" | "queuedOnLabel">;
}>;

export type FleetRouteTable = Readonly<{
	routes: Readonly<Record<string, string>>;
	decisions: Readonly<Record<string, FleetBalance>>;
}>;

const CLASS_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const LABEL = /^[A-Za-z0-9_.-]{1,100}$/;

export function fleetRouteTable(
	input: Omit<FleetBalanceInput, "demand"> & {
		classes: readonly FleetRouteClass[];
	},
): FleetRouteTable {
	const { classes, ...shared } = input;
	const routes: Record<string, string> = {};
	const decisions: Record<string, FleetBalance> = {};
	for (const routeClass of classes) {
		if (!CLASS_NAME.test(routeClass.name) || routeClass.name in routes)
			throw new TypeError(`invalid or repeated route class ${routeClass.name}`);
		if (!LABEL.test(routeClass.hoboLabel))
			throw new TypeError(`invalid hobo label for ${routeClass.name}`);
		const decision = balanceFleet({
			...shared,
			demand: { ...routeClass.demand, id: `fleet-route:${routeClass.name}` },
		});
		decisions[routeClass.name] = decision;
		routes[routeClass.name] =
			decision.selected?.binding === "label"
				? decision.selected.runsOn
				: routeClass.hoboLabel;
	}
	return { routes, decisions };
}

export function fleetRoutesVariableValue(table: FleetRouteTable): string {
	return JSON.stringify(
		Object.fromEntries(
			Object.entries(table.routes).sort(([left], [right]) =>
				left < right ? -1 : left > right ? 1 : 0,
			),
		),
	);
}
