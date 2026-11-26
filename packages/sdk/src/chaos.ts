import { deepFreeze, requireNonEmptyString, requireRecord } from "./errors.js";
import { CHAOS_SCHEMA } from "./schema.js";

// Greenfield declaration factory (walkthrough §6.4): a chaos experiment is a
// typed hypothesis — steady-state invariant, injected fault, bounded blast
// radius, abort trip-wire. executeChaosExperiment executes the declaration
// against an isolated target/Camp membrane, records actual fault observations,
// checks executable invariants, and restores injected faults.

// domain-view: authored chaos injection; wire form is ChaosInjection in data-models/sdk.proto.
export interface ChaosInjection {
	readonly fault: string;
	readonly target: string;
}

// domain-view: authored chaos experiment; wire form is ChaosDeclaration in data-models/sdk.proto.
export interface ChaosDeclaration {
	readonly schema: string;
	readonly name: string;
	/** The invariant that must keep holding, e.g. "slo:checkout.latency". */
	readonly steadyState: string;
	readonly inject: ChaosInjection;
	/** Bounded scope, e.g. "1 camp" — never the whole fleet. */
	readonly blastRadius: string;
	/** Trip-wire: stop and roll back when this predicate fires. */
	readonly abortIf?: string;
}

export interface ChaosSpec {
	steadyState: string;
	inject: { fault: string; target: string };
	blastRadius: string;
	abortIf?: string;
}

export function chaos(name: string, spec: ChaosSpec): ChaosDeclaration {
	requireNonEmptyString("chaos", "name", name);
	const record = requireRecord("chaos", "spec", spec);
	const steadyState = requireNonEmptyString(
		"chaos",
		"steadyState",
		record.steadyState,
	);
	const inject = requireRecord("chaos", "inject", record.inject);
	const fault = requireNonEmptyString("chaos", "inject.fault", inject.fault);
	const target = requireNonEmptyString("chaos", "inject.target", inject.target);
	const blastRadius = requireNonEmptyString(
		"chaos",
		"blastRadius",
		record.blastRadius,
	);
	const abortIf =
		record.abortIf === undefined
			? undefined
			: requireNonEmptyString("chaos", "abortIf", record.abortIf);

	return deepFreeze({
		schema: CHAOS_SCHEMA,
		name,
		steadyState,
		inject: { fault, target },
		blastRadius,
		...(abortIf !== undefined ? { abortIf } : undefined),
	});
}
