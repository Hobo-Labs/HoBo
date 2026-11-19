import type { EventEnvelope } from "@hobo/core";
import { describe, expect, test } from "vitest";

import {
	AggregateConflictError,
	AggregateInvariantError,
	AggregateStaleFenceError,
	isOptimisticConflict,
	isStaleFenceError,
	ProjectionWriteError,
} from "../src/errors.js";
import { foldEvents } from "../src/fold.js";
import { isJsonNumber, type JsonObject } from "../src/json.js";

let nextSeq = 0;

function envelope(
	type: string,
	data: JsonObject = {},
	overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
	nextSeq += 1;

	return {
		id: `evt-${nextSeq}`,
		type,
		v: 1,
		streamId: "stream-1",
		seq: nextSeq,
		ts: "2026-01-01T00:00:00.000Z",
		actor: { kind: "service", id: "test" },
		tenant: "tenant-a",
		data,
		...overrides,
	} as EventEnvelope;
}

function dataOf(event: EventEnvelope): JsonObject {
	return event.data as JsonObject;
}

const counting = {
	initialState: { total: 0 },
	evolve: (state: { total: number }, event: EventEnvelope) => ({
		total: state.total + Number(dataOf(event).amount ?? 0),
	}),
};

describe("foldEvents", () => {
	test("an empty stream yields the initial state at seq zero", () => {
		const outcome = foldEvents([], counting);
		expect(outcome.state).toEqual({ total: 0 });
		expect(outcome.seq).toBe(0);
		expect(outcome.quarantined).toEqual([]);
	});

	test("events are folded in order and the seq is the last one seen", () => {
		const outcome = foldEvents(
			[
				envelope("item.Added", { amount: 2 }),
				envelope("item.Added", { amount: 3 }),
			],
			counting,
		);
		expect(outcome.state).toEqual({ total: 5 });
		expect(outcome.seq).toBeGreaterThan(0);
	});

	test("evolves directly from the stored event data", () => {
		const event = envelope("item.Added", { amount: 7, unit: "items" });
		let received: EventEnvelope | undefined;
		const outcome = foldEvents([event], {
			initialState: { total: 0 },
			evolve: (state, input) => {
				received = input;
				return { total: state.total + Number(dataOf(input).amount) };
			},
		});
		expect(received).toEqual(event);
		expect(outcome.state).toEqual({ total: 7 });
	});

	test("the seq is the maximum, not the last value seen", () => {
		const first = envelope("item.Added", { amount: 1 }, { seq: 9 });
		const second = envelope("item.Added", { amount: 1 }, { seq: 4 });
		expect(foldEvents([first, second], counting).seq).toBe(9);
	});

	test("the initial state is not mutated by a fold", () => {
		const spec = { ...counting, initialState: { total: 0 } };
		foldEvents([envelope("item.Added", { amount: 5 })], spec);
		expect(spec.initialState).toEqual({ total: 0 });
	});

	test("the event handed to evolve is frozen", () => {
		let sawFrozen: boolean | undefined;
		foldEvents([envelope("item.Added", { amount: 1 })], {
			initialState: { total: 0 },
			evolve: (state, event) => {
				sawFrozen = Object.isFrozen(event);
				return state;
			},
		});
		expect(sawFrozen).toBe(true);
	});

	test("mutating the state passed to evolve does not corrupt the fold", () => {
		const outcome = foldEvents(
			[
				envelope("item.Added", { amount: 1 }),
				envelope("item.Added", { amount: 1 }),
			],
			{
				initialState: { total: 0 },
				evolve: (state: { total: number }, event) => {
					state.total = 999;
					return {
						total:
							Number(dataOf(event).amount ?? 0) +
							(state.total === 999 ? 0 : state.total),
					};
				},
			},
		);
		expect(outcome.state.total).toBe(1);
	});
});

describe("quarantine determinism", () => {
	test("an evolve that throws quarantines the event instead of wedging the stream", () => {
		const outcome = foldEvents(
			[
				envelope("item.Added", { amount: 1 }),
				envelope("item.Added", { amount: "poison" }),
				envelope("item.Added", { amount: 2 }),
			],
			{
				initialState: { total: 0 },
				evolve: (state: { total: number }, event) => {
					const amount = dataOf(event).amount;
					if (!isJsonNumber(amount)) throw new Error("bad amount");
					return { total: state.total + amount };
				},
			},
		);
		expect(outcome.state).toEqual({ total: 3 });
		expect(outcome.quarantined).toHaveLength(1);
	});

	test("the quarantine record names the offending seq and the reason", () => {
		const poison = envelope("item.Added", { amount: "poison" });
		const outcome = foldEvents([poison], {
			initialState: { total: 0 },
			evolve: () => {
				throw new Error("bad amount");
			},
		});
		expect(outcome.quarantined[0]?.offendingSeq).toBe(poison.seq);
		expect(outcome.quarantined[0]?.reason).toBe("bad amount");
	});

	test("the quarantine fact type is derived from the event's family", () => {
		const outcome = foldEvents([envelope("item.Added", {})], {
			initialState: {},
			evolve: () => {
				throw new Error("boom");
			},
		});
		expect(outcome.quarantined[0]?.type).toBe("item.Quarantined");
	});

	test("a non-Error thrown value still produces a readable reason", () => {
		const outcome = foldEvents([envelope("item.Added", {})], {
			initialState: {},
			evolve: () => {
				throw "a string failure";
			},
		});
		expect(outcome.quarantined[0]?.reason).toContain("a string failure");
	});

	test("a persisted quarantine fact skips its offending event on replay", () => {
		const poison = envelope("item.Added", { amount: 5 });
		const fact = envelope("item.Quarantined", { offendingSeq: poison.seq });
		const outcome = foldEvents([poison, fact], counting);
		expect(outcome.state).toEqual({ total: 0 });

		expect(outcome.quarantined).toEqual([]);
	});

	test("a quarantine fact appearing before its target still neutralises it", () => {
		const poison = envelope("item.Added", { amount: 5 }, { seq: 20 });
		const fact = envelope(
			"item.Quarantined",
			{ offendingSeq: 20 },
			{ seq: 10 },
		);
		expect(foldEvents([fact, poison], counting).state).toEqual({ total: 0 });
	});

	test("a live fold and a replay with the fact reach the same state", () => {
		const good = envelope("item.Added", { amount: 4 });
		const poison = envelope("item.Added", { amount: "poison" });
		const spec = {
			initialState: { total: 0 },
			evolve: (state: { total: number }, event: EventEnvelope) => {
				const amount = dataOf(event).amount;
				if (!isJsonNumber(amount)) throw new Error("bad amount");
				return { total: state.total + amount };
			},
		};

		const live = foldEvents([good, poison], spec);
		const fact = envelope("item.Quarantined", {
			offendingSeq: live.quarantined[0]?.offendingSeq,
		});

		const replay = foldEvents([good, poison, fact], {
			initialState: { total: 0 },
			evolve: (state: { total: number }, event) => ({
				total: state.total + Number(dataOf(event).amount ?? 0),
			}),
		});
		expect(replay.state).toEqual(live.state);
	});

	test("quarantine facts are never folded as ordinary events", () => {
		const outcome = foldEvents(
			[envelope("item.Quarantined", { offendingSeq: 999, amount: 100 })],
			counting,
		);
		expect(outcome.state).toEqual({ total: 0 });
	});

	test("rejects a quarantine fact with an invalid target sequence", () => {
		expect(() =>
			foldEvents(
				[
					envelope("item.Quarantined", { offendingSeq: "not-a-number" }),
					envelope("item.Added", { amount: 7 }),
				],
				counting,
			),
		).toThrow();
	});

	test("several poison events are each quarantined", () => {
		const outcome = foldEvents(
			[
				envelope("item.Added", { amount: "a" }),
				envelope("item.Added", { amount: 1 }),
				envelope("item.Added", { amount: "b" }),
			],
			{
				initialState: { total: 0 },
				evolve: (state: { total: number }, event) => {
					const amount = dataOf(event).amount;
					if (!isJsonNumber(amount)) throw new Error("bad");
					return { total: state.total + amount };
				},
			},
		);
		expect(outcome.quarantined).toHaveLength(2);
		expect(outcome.state).toEqual({ total: 1 });
	});

	test("the quarantine seq is past the stream head", () => {
		const outcome = foldEvents([envelope("item.Added", {}, { seq: 50 })], {
			initialState: {},
			evolve: () => {
				throw new Error("boom");
			},
		});
		expect(outcome.quarantined[0]?.quarantineSeq).toBeGreaterThan(50);
	});
});

describe("the typed errors", () => {
	test("an invariant violation is explicitly not retryable", () => {
		const error = new AggregateInvariantError("cart already checked out");
		expect(error.code).toBe("AGGREGATE_INVARIANT");
		expect(error.retryable).toBe(false);
		expect(error.name).toBe("AggregateInvariantError");
	});

	test("a conflict is retryable and names what to re-fold", () => {
		const error = new AggregateConflictError("cart-1", 7);
		expect(error.code).toBe("AGGREGATE_CONFLICT");
		expect(error.retryable).toBe(true);
		expect(error.streamId).toBe("cart-1");
		expect(error.expectedSeq).toBe(7);
		expect(error.message).toContain("cart-1");
		expect(error.message).toContain("7");
	});

	test("a conflict accepts a custom message", () => {
		expect(new AggregateConflictError("cart-1", 7, "custom").message).toBe(
			"custom",
		);
	});

	test("a stale fence is not retryable", () => {
		const error = new AggregateStaleFenceError("cart-1");
		expect(error.code).toBe("STALE_FENCE");
		expect(error.retryable).toBe(false);
		expect(error.streamId).toBe("cart-1");
		expect(error.message).toContain("cart-1");
	});

	test("a stale fence accepts a custom message", () => {
		expect(new AggregateStaleFenceError("cart-1", "taken over").message).toBe(
			"taken over",
		);
	});

	test("a projection write error names the forbidden boundary", () => {
		const error = new ProjectionWriteError("tried to append from a projection");
		expect(error.code).toBe("PROJECTION_WRITE_FORBIDDEN");
		expect(error.name).toBe("ProjectionWriteError");
	});

	test("every typed error is a real Error", () => {
		for (const error of [
			new AggregateInvariantError("x"),
			new AggregateConflictError("s", 1),
			new AggregateStaleFenceError("s"),
			new ProjectionWriteError("x"),
		]) {
			expect(error).toBeInstanceOf(Error);
			expect(error.stack).toBeTypeOf("string");
		}
	});
});

describe("recognising a runtime conflict without depending on the runtime", () => {
	test("this package's own conflict is recognised", () => {
		expect(isOptimisticConflict(new AggregateConflictError("s", 1))).toBe(true);
	});

	test("the runtime EventStore's signals are recognised by name", () => {
		for (const name of [
			"OptimisticSequenceConflictError",
			"StaleSequenceError",
		]) {
			expect(isOptimisticConflict({ name })).toBe(true);
		}
	});

	test("the conflict code is recognised as well as the names", () => {
		expect(isOptimisticConflict({ code: "OPTIMISTIC_SEQUENCE_CONFLICT" })).toBe(
			true,
		);
	});

	test("an unrelated error is not a conflict", () => {
		expect(isOptimisticConflict(new Error("disk full"))).toBe(false);
		expect(isOptimisticConflict(new AggregateInvariantError("x"))).toBe(false);
	});

	test("null and undefined are not conflicts", () => {
		expect(isOptimisticConflict(null)).toBe(false);
		expect(isOptimisticConflict(undefined)).toBe(false);
	});

	test("a stale fence is recognised by name or code", () => {
		expect(isStaleFenceError({ name: "StaleFenceError" })).toBe(true);
		expect(isStaleFenceError({ code: "STALE_FENCE" })).toBe(true);
		expect(isStaleFenceError(new AggregateStaleFenceError("s"))).toBe(true);
	});

	test("a conflict is not a stale fence", () => {
		expect(isStaleFenceError(new AggregateConflictError("s", 1))).toBe(false);
		expect(isOptimisticConflict(new AggregateStaleFenceError("s"))).toBe(false);
	});

	test("null and undefined are not stale fences", () => {
		expect(isStaleFenceError(null)).toBe(false);
		expect(isStaleFenceError(undefined)).toBe(false);
	});
});
