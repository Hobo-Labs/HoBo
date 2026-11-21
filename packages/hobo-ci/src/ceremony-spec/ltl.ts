/**
 * Linear temporal logic over finite traces (LTLf), the logic Bombadil's
 * properties are written in, for traces of a ceremony as the owner's host
 * sees it. Future operators (`always`, `eventually`, `next`, `within`) and a
 * past one (`once`: "earlier in this trace"), which safety properties such
 * as "no form before its link" need.
 *
 * A formula is evaluated at a position of a finite trace. `check` evaluates
 * at the start and, when the formula does not hold, names the first position
 * where an `always` was broken: the counterexample a failing property shows.
 */

export type Formula<E> = (trace: readonly E[], at: number) => boolean;

/** A property of the event at this position (false past the end). */
export function atom<E>(holds: (event: E) => boolean): Formula<E> {
	return (trace, at) => {
		const event = trace[at];
		return event !== undefined && holds(event);
	};
}

export const not =
	<E>(formula: Formula<E>): Formula<E> =>
	(trace, at) =>
		!formula(trace, at);

export const and =
	<E>(...formulas: readonly Formula<E>[]): Formula<E> =>
	(trace, at) =>
		formulas.every((formula) => formula(trace, at));

export const or =
	<E>(...formulas: readonly Formula<E>[]): Formula<E> =>
	(trace, at) =>
		formulas.some((formula) => formula(trace, at));

export const implies =
	<E>(premise: Formula<E>, conclusion: Formula<E>): Formula<E> =>
	(trace, at) =>
		!premise(trace, at) || conclusion(trace, at);

/** Holds at every position from here to the end. */
export const always =
	<E>(formula: Formula<E>): Formula<E> =>
	(trace, at) => {
		for (let step = at; step < trace.length; step += 1)
			if (!formula(trace, step)) return false;
		return true;
	};

/** Holds at some position from here to the end. */
export const eventually =
	<E>(formula: Formula<E>): Formula<E> =>
	(trace, at) => {
		for (let step = at; step < trace.length; step += 1)
			if (formula(trace, step)) return true;
		return false;
	};

/** Holds at some position within `steps` positions from here. */
export const within =
	<E>(steps: number, formula: Formula<E>): Formula<E> =>
	(trace, at) => {
		const last = Math.min(trace.length - 1, at + steps);
		for (let step = at; step <= last; step += 1)
			if (formula(trace, step)) return true;
		return false;
	};

/** Holds at the next position (strong: false at the last). */
export const next =
	<E>(formula: Formula<E>): Formula<E> =>
	(trace, at) =>
		at + 1 < trace.length && formula(trace, at + 1);

/** Held at this position or an earlier one (past "once"). */
export const once =
	<E>(formula: Formula<E>): Formula<E> =>
	(trace, at) => {
		for (let step = Math.min(at, trace.length - 1); step >= 0; step -= 1)
			if (formula(trace, step)) return true;
		return false;
	};

/** A named property: an `always` of `invariant`, or a whole-trace formula. */
export type Property<E> =
	| {
			readonly name: string;
			readonly kind: "invariant";
			/** Must hold at every position. */
			readonly invariant: Formula<E>;
	  }
	| {
			readonly name: string;
			readonly kind: "trace";
			/** Must hold at the start of the trace. */
			readonly formula: Formula<E>;
	  };

export interface Verdict<E> {
	readonly property: string;
	readonly holds: boolean;
	/** For an invariant that fails: the first position, and its event. */
	readonly at?: number;
	readonly event?: E;
}

/** Evaluate a property; an invariant that fails names its first violation. */
export function check<E>(
	property: Property<E>,
	trace: readonly E[],
): Verdict<E> {
	if (property.kind === "trace")
		return {
			property: property.name,
			holds: property.formula(trace, 0),
		};
	for (let step = 0; step < trace.length; step += 1)
		if (!property.invariant(trace, step)) {
			const event = trace[step];
			return event === undefined
				? { property: property.name, holds: false, at: step }
				: { property: property.name, holds: false, at: step, event };
		}
	return { property: property.name, holds: true };
}
