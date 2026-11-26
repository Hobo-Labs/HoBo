import { describe, expect, it } from "vitest";
import type { JsonValue } from "../../src/json.js";

import { ReplayDivergenceError } from "../../src/replay/divergence.js";
import {
	assertReplayEqualsLive,
	hashReadSet,
	interleaveStreams,
	seqVector,
} from "../../src/replay/equivalence.js";
import type { EventEnvelope } from "../../src/replay/types.js";

describe("equivalence harness", () => {
	it("proves deterministic folds across fuzzed stream interleavings", () => {
		for (let seed = 1; seed <= 64; seed += 1) {
			const events = interleaveStreams(makeStreams(seed), `interleave-${seed}`);
			const result = assertReplayEqualsLive({
				events,
				initialState: emptyLedger(),
				fold: deterministicLedgerFold,
				seed: `case-${seed}`,
			});

			expect(result.stateDigest).toHaveLength(64);
			expect(result.seqVector).toEqual(toEntries(seqVector(events)));
			expect(result.readSetHash).toBe(hashReadSet(events));
		}
	});

	it("catches folds that read the ambient wall clock", () => {
		const events = interleaveStreams(makeStreams(1), "wall-clock");

		expect(() =>
			assertReplayEqualsLive({
				events,
				initialState: { lastWallClock: 0 },
				fold: (state) => ({ ...state, lastWallClock: Date.now() }),
			}),
		).toThrow(ReplayDivergenceError);
	});

	it("catches floating-point accumulation order drift", () => {
		const events = [
			event("a", 1, "metric.delta", { amount: 10_000_000_000_000_000 }),
			event("c", 1, "metric.delta", { amount: 1 }),
			event("b", 1, "metric.delta", { amount: -10_000_000_000_000_000 }),
		];

		expect(() =>
			assertReplayEqualsLive({
				events,
				initialState: { total: 0 },
				fold: (state, currentEvent) => ({
					// SAFETY: assertion to `currentEvent.data as { amount: number }` is required at this boundary.
					total: state.total + (currentEvent.data as { amount: number }).amount,
				}),
			}),
		).toThrow(ReplayDivergenceError);
	});

	it("catches impure upcasters", () => {
		const events = [event("ticket", 1, "ticket.delta", { cents: 1 }, 1)];

		expect(() =>
			assertReplayEqualsLive({
				events,
				initialState: emptyLedger(),
				fold: deterministicLedgerFold,
				upcast: (currentEvent) => ({
					...currentEvent,
					data: { cents: Math.random() },
				}),
			}),
		).toThrow(ReplayDivergenceError);
	});
});

function deterministicLedgerFold(
	state: ReturnType<typeof emptyLedger>,
	currentEvent: EventEnvelope,
	context: { now(): string },
) {
	const nextByStream = {
		...state.byStream,
		[currentEvent.streamId]:
			(state.byStream[currentEvent.streamId] ?? 0) +
			// SAFETY: assertion to `currentEvent.data as { cents: number }` is required at this boundary.
			(currentEvent.data as { cents: number }).cents,
	};
	const nextSeq = {
		...state.seq,
		[currentEvent.streamId]: Math.max(
			state.seq[currentEvent.streamId] ?? 0,
			currentEvent.seq,
		),
	};

	return {
		byStream: sortObject(nextByStream),
		seq: sortObject(nextSeq),
		seededClockByEvent: sortObject({
			...state.seededClockByEvent,
			[`${currentEvent.streamId}:${currentEvent.seq}`]: context.now(),
		}),
		totalCents: Object.values(nextByStream).reduce(
			(sum, cents) => sum + cents,
			0,
		),
	};
}

function makeStreams(seed: number) {
	return {
		"ticket-a": [
			event("ticket-a", 1, "ticket.delta", { cents: 100 + seed }),
			event("ticket-a", 2, "ticket.delta", { cents: 30 }),
			event("ticket-a", 3, "ticket.delta", { cents: 7 }),
		],
		"ticket-b": [
			event("ticket-b", 1, "ticket.delta", { cents: 50 }),
			event("ticket-b", 2, "ticket.delta", { cents: seed }),
		],
		"ticket-c": [
			event("ticket-c", 1, "ticket.delta", { cents: 3 }),
			event("ticket-c", 2, "ticket.delta", { cents: 4 }),
		],
	};
}

function event(
	streamId: string,
	seq: number,
	type: string,
	data: JsonValue,
	version = 1,
): EventEnvelope {
	return { id: `${streamId}-${seq}`, streamId, seq, type, v: version, data };
}

function emptyLedger() {
	return { byStream: {}, seq: {}, seededClockByEvent: {}, totalCents: 0 };
}

function sortObject<T extends Record<string, number>>(value: T): T {
	// SAFETY: assertion to `Object.fromEntries( Object.entries(value).sort(([left], [right]) => left.localeCompare(right)), ) as T` is required at this boundary.
	return Object.fromEntries(
		Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
	) as T;
}

function toEntries(vector: Record<string, number>) {
	return Object.entries(vector)
		.map(([streamId, seq]) => ({ streamId, seq }))
		.sort((left, right) => left.streamId.localeCompare(right.streamId));
}
