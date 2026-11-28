import fc from "fast-check";
import { expect, it } from "vitest";
import { digest } from "../../src/replay/divergence.js";
import {
	assertReplayEqualsLive,
	seqVector,
} from "../../src/replay/equivalence.js";
import type { EventEnvelope } from "../../src/replay/types.js";

function event(streamId: string, seq: number): EventEnvelope {
	return { id: `${streamId}-${seq}`, streamId, seq, type: "item", data: null };
}

it("keeps streams whose names match object prototype properties", () => {
	const events = [
		event("__proto__", 1),
		event("constructor", 2),
		event("toString", 3),
	];
	const vector = seqVector(events);
	for (const item of events) {
		expect(Object.hasOwn(vector, item.streamId)).toBe(true);
		expect(vector[item.streamId]).toBe(item.seq);
	}
	const report = assertReplayEqualsLive({
		events,
		initialState: 0,
		fold: (count) => count + 1,
	});
	expect(report.stateDigest).toBe(digest(3));
});

it("ignores inherited sequence entries in a supplied target vector", () => {
	const target = Object.create({ inherited: 10 });
	const report = assertReplayEqualsLive({
		events: [event("inherited", 1)],
		targetSeq: target,
		initialState: 0,
		fold: (count) => count + 1,
	});
	expect(report.stateDigest).toBe(digest(0));
});

it("ignores inherited entries on the snapshot's object prototype", () => {
	const key = "sequence_vector_inherited_boundary";
	const previous = Object.getOwnPropertyDescriptor(Object.prototype, key);
	try {
		Object.defineProperty(Object.prototype, key, {
			value: 10,
			configurable: true,
		});
		const report = assertReplayEqualsLive({
			events: [event(key, 1)],
			targetSeq: {},
			initialState: 0,
			fold: (count) => count + 1,
		});
		expect(report.stateDigest).toBe(digest(0));
	} finally {
		if (previous) Object.defineProperty(Object.prototype, key, previous);
		else Reflect.deleteProperty(Object.prototype, key);
	}
});

it("tracks the maximum sequence for generated nonempty stream names", () => {
	const stream = fc.oneof(
		fc.string({ minLength: 1, maxLength: 15 }),
		fc.constantFrom("__proto__", "constructor", "toString", "valueOf"),
	);
	fc.assert(
		fc.property(
			fc.array(fc.tuple(stream, fc.integer({ min: 1, max: 10_000 })), {
				maxLength: 40,
			}),
			(items) => {
				const expected = new Map<string, number>();
				const events = items.map(([id, seq]) => {
					expected.set(id, Math.max(expected.get(id) ?? 0, seq));
					return event(id, seq);
				});
				const vector = seqVector(events);
				expect(Object.keys(vector)).toHaveLength(expected.size);
				for (const [id, seq] of expected) {
					expect(Object.hasOwn(vector, id)).toBe(true);
					expect(vector[id]).toBe(seq);
				}
				const report = assertReplayEqualsLive({
					events,
					initialState: 0,
					fold: (count) => count + 1,
				});
				expect(report.stateDigest).toBe(digest(events.length));
			},
		),
		{ seed: 614610, numRuns: 150 },
	);
});
