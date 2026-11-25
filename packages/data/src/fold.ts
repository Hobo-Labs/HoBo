import type { EventEnvelope, QuarantineRecord } from "@hobo/core";

import { parseOffendingSeq } from "./json.js";
import type { UpcasterRegistry } from "./upcaster.js";

// A deterministic fold `(state, event) -> state`, read-only by contract.
export type Evolve<S> = (state: S, event: EventEnvelope) => S;

export interface FoldSpec<S> {
	initialState: S;
	evolve: Evolve<S>;
	upcasters?: UpcasterRegistry;
}

export interface FoldOutcome<S> {
	state: S;
	// The stream length folded over (== the seq of the last event seen), which a
	// command uses as its optimistic `expectedSeq` for the next append.
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

// Fold an event stream into a state, applying upcasters on read and honoring
// poison-event quarantine deterministically (data-plane.md §Schema evolution):
//   * a persisted `*.Quarantined` fact carries the `offendingSeq` it neutralizes;
//     that seq is skipped on every replay, so live and replayed folds agree.
//   * an evolve/upcast that throws in THIS pass is recorded as a fresh quarantine
//     record (the caller persists the `*.Quarantined` fact) and skipped, so one
//     bad body never wedges the stream.
export function foldEvents<S>(
	events: Iterable<EventEnvelope>,
	spec: FoldSpec<S>,
): FoldOutcome<S> {
	const materialized = [...events];

	// Pass 1: collect the seqs already neutralized by persisted quarantine facts.
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
			// The upcast belongs inside the guard, not before it. The contract
			// above says "an evolve/upcast that throws in THIS pass is recorded as
			// a fresh quarantine record ... so one bad body never wedges the
			// stream" — but with the upcast outside, a migration that threw on one
			// stored body propagated straight out of foldEvents and made the whole
			// aggregate unloadable. Permanently, because the upcaster runs again on
			// every replay: the quarantine fact that would have neutralised the
			// event could never be produced, since producing it required the fold
			// to finish.
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
