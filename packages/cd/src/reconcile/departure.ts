// Departure (D21, D23). A Camp leaving a placement receives a `depart` Set
// (SET_ORIGIN_DEPARTURE). What happens to the resources it no longer declares
// follows the node's DepartureAction:
//   DELETE        remove everything the Set no longer declares;
//   ORPHAN        remove nothing, record everything as orphaned;
//   ORPHAN_DATA   (default) remove compute, keep data resources, record them.
// Kept resources are passed to the realizer as `keep` and recorded in
// `camp.Departed`; the reconciler verifies afterwards that they still exist.
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

/** The DepartureAction CD_DEFAULTS names (ORPHAN_DATA). */
export function defaultDepartureAction(): DepartureAction {
	const name = CD_DEFAULTS.departureAction;
	return DepartureAction[name];
}

/**
 * Decide which undeclared resources go and which stay. `observed` is what the
 * target holds now; `declared` is what the departure Set still declares.
 */
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

/** Kept resources that the realizer removed anyway (should be empty). */
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

/**
 * Realize directives the reconciler adds to RealizeInput. `keep` names
 * resources the realizer must not delete even though the desired Set no
 * longer declares them (departure orphans). Realizers that do not read it
 * are caught by `keptButMissing` after converge.
 */
export type RealizeDirectives = Readonly<{ keep?: readonly string[] }>;

export type DirectedRealizeInput = RealizeInput & RealizeDirectives;

/** Read `keep` from a RealizeInput that may carry directives. */
export function keepOf(input: RealizeInput): ReadonlySet<string> {
	const directed: DirectedRealizeInput = input;
	return new Set(directed.keep ?? []);
}
