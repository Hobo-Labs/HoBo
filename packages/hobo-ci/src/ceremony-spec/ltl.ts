
export type Formula<E> = (trace: readonly E[], at: number) => boolean;

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

export const always =
	<E>(formula: Formula<E>): Formula<E> =>
	(trace, at) => {
		for (let step = at; step < trace.length; step += 1)
			if (!formula(trace, step)) return false;
		return true;
	};

export const eventually =
	<E>(formula: Formula<E>): Formula<E> =>
	(trace, at) => {
		for (let step = at; step < trace.length; step += 1)
			if (formula(trace, step)) return true;
		return false;
	};

export const within =
	<E>(steps: number, formula: Formula<E>): Formula<E> =>
	(trace, at) => {
		const last = Math.min(trace.length - 1, at + steps);
		for (let step = at; step <= last; step += 1)
			if (formula(trace, step)) return true;
		return false;
	};

export const next =
	<E>(formula: Formula<E>): Formula<E> =>
	(trace, at) =>
		at + 1 < trace.length && formula(trace, at + 1);

export const once =
	<E>(formula: Formula<E>): Formula<E> =>
	(trace, at) => {
		for (let step = Math.min(at, trace.length - 1); step >= 0; step -= 1)
			if (formula(trace, step)) return true;
		return false;
	};

export type Property<E> =
	| {
			readonly name: string;
			readonly kind: "invariant";
			readonly invariant: Formula<E>;
	  }
	| {
			readonly name: string;
			readonly kind: "trace";
			readonly formula: Formula<E>;
	  };

export interface Verdict<E> {
	readonly property: string;
	readonly holds: boolean;
	readonly at?: number;
	readonly event?: E;
}

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
