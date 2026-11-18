import {
	DepartureAction,
	type ReconcileObservationRecord,
	type ResourceObservation,
} from "../_generated/cd_pb.js";
import { CD_DEFAULTS } from "../events.js";
import type { RealizeInput } from "../ports.js";
import { isDataResource } from "./drift.js";

export type DeparturePlan = Readonly<{
	action: DepartureAction;
	remove: readonly string[];
	keep: readonly string[];
}>;

export function defaultDepartureAction(): DepartureAction {
	const name = CD_DEFAULTS.departureAction;
	return DepartureAction[name];
}

export function planDeparture(
	input: Readonly<{
		action: DepartureAction;
		observed: readonly Pick<
			ResourceObservation,
			"resource" | "kind" | "classification"
		>[];
		declared: readonly string[];
	}>,
): DeparturePlan {
	const action =
		input.action === DepartureAction.UNSPECIFIED
			? defaultDepartureAction()
			: input.action;
	const declared = new Set(input.declared);
	const remove: string[] = [];
	const keep: string[] = [];
	for (const resource of input.observed) {
		if (declared.has(resource.resource)) continue;
		if (action === DepartureAction.DELETE) remove.push(resource.resource);
		else if (action === DepartureAction.ORPHAN) keep.push(resource.resource);
		else if (isDataResource(resource)) keep.push(resource.resource);
		else remove.push(resource.resource);
	}
	return Object.freeze({
		action,
		remove: Object.freeze([...new Set(remove)].sort()),
		keep: Object.freeze([...new Set(keep)].sort()),
	});
}

export function keptButMissing(
	plan: DeparturePlan,
	after: ReconcileObservationRecord,
): readonly string[] {
	const present = new Set(
		after.resources
			.filter((resource) => {
				const drift = resource.driftKind.split(":")[0];
				return drift !== "deleted";
			})
			.map((resource) => resource.resource),
	);
	return Object.freeze(plan.keep.filter((name) => !present.has(name)));
}

export type RealizeDirectives = Readonly<{ keep?: readonly string[] }>;

export type DirectedRealizeInput = RealizeInput & RealizeDirectives;

export function keepOf(input: RealizeInput): ReadonlySet<string> {
	const directed: DirectedRealizeInput = input;
	return new Set(directed.keep ?? []);
}
