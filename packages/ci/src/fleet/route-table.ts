/**
 * The route table: which `runs-on` label each class of job should ask for.
 *
 * A label provider can only take a job that asks for its label, and GitHub
 * fixes `runs-on` when the job is queued. So the decision has to be made
 * before that, and published where a workflow can read it without running
 * anything: a repository variable holding this table. A workflow indexes it
 * by job class and falls back to the hobo label when the variable is unset or
 * a class is missing, which is exactly today's behavior.
 *
 * A class whose best member is injected, or that has no admitted member at
 * all, stays on its hobo label. Waiting there is the only place a job can
 * still be rescued, because injected capacity can come to it later.
 *
 * The published value is constrained by `#FleetRoutes` in
 * `data-models/ci.cue`; a class added here needs a fixture there.
 */

import {
	balanceFleet,
	type FleetBalance,
	type FleetBalanceInput,
	type FleetDemand,
} from "./balance.js";

/** Repository variable the relay publishes the table to. */
// public-contract: workflows read their runs-on label from this variable.
export const FLEET_ROUTES_VARIABLE = "HOBO_CI_FLEET_ROUTES";

export type FleetRouteClass = Readonly<{
	/** Key a workflow indexes the table with, for example `pr` or `trunk`. */
	name: string;
	/** Label injected runners serve for this class: `hobo` or `hobo-trunk`. */
	hoboLabel: string;
	/** A representative job of this class that has not been queued yet. */
	demand: Omit<FleetDemand, "id" | "queuedOnLabel">;
}>;

export type FleetRouteTable = Readonly<{
	/** Class name to `runs-on` label. */
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

/** Canonical variable value: sorted keys, no whitespace. */
export function fleetRoutesVariableValue(table: FleetRouteTable): string {
	return JSON.stringify(
		Object.fromEntries(
			Object.entries(table.routes).sort(([left], [right]) =>
				left < right ? -1 : left > right ? 1 : 0,
			),
		),
	);
}
