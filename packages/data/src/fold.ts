import type { EventEnvelope, QuarantineRecord } from "@hobo/core";

import { parseOffendingSeq } from "./json.js";
import type { UpcasterRegistry } from "./upcaster.js";

export type Evolve<S> = (state: S, event: EventEnvelope) => S;

export interface FoldSpec<S> {
	initialState: S;
	evolve: Evolve<S>;
	upcasters?: UpcasterRegistry;
}

export interface FoldOutcome<S> {
	state: S;
	seq: number;
	quarantined: QuarantineRecord[];
}

function clone<T>(value: T): T {
	if (value === undefined) return value;
	return structuredClone(value);
}

function isQuarantineFact(event: EventEnvelope): boolean {
	return event.type.endsWith(".Quarantined");
}

export function foldEvents<S>(
	events: Iterable<EventEnvelope>,
	spec: FoldSpec<S>,
): FoldOutcome<S> {
	const materialized = [...events];

	const quarantinedSeqs = new Set<number>();
	for (const event of materialized) {
		if (isQuarantineFact(event)) {
			const offending = parseOffendingSeq(event.data);
			if (offending !== undefined) quarantinedSeqs.add(offending);
		}
	}

	let state = clone(spec.initialState);
	let seq = 0;
	const quarantined: QuarantineRecord[] = [];

	for (const event of materialized) {
		seq = Math.max(seq, event.seq);
		if (isQuarantineFact(event) || quarantinedSeqs.has(event.seq)) continue;

		try {
			const upcast = spec.upcasters ? spec.upcasters.upcast(event) : event;
			state = clone(spec.evolve(clone(state), Object.freeze(clone(upcast))));
		} catch (cause) {
			quarantinedSeqs.add(event.seq);
			quarantined.push({
				offendingSeq: event.seq,
				quarantineSeq: seq + 1,
				type: `${event.type.split(".")[0] ?? "event"}.Quarantined`,
				reason: cause instanceof Error ? cause.message : String(cause),
			});
		}
	}

	return { state: clone(state), seq, quarantined };
}
