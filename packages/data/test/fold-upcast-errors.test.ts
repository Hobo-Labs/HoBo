/**
 * Three small modules that together decide whether an event stream stays
 * replayable forever.
 *
 * `foldEvents` has one property everything else depends on: a replay must reach
 * the same state as the original live pass. That is why quarantine is persisted
 * as a *fact* carrying the seq it neutralises rather than being decided afresh
 * each time — if the fold re-judged a poison event on every replay, a body that
 * happened to throw once and not the next time would give two different states
 * from the same log.
 *
 * `createUpcasterRegistry` is the other half: old events are never rewritten, so
 * every read walks them forward through a chain of pure transforms. A chain with
 * a gap silently stops upcasting partway and hands the caller a half-migrated
 * body that still claims its old version.
 *
 * The typed errors exist so a caller can tell "your command was illegal, do not
 * retry" from "someone appended first, re-fold and try again" — collapsing those
 * two produces either an infinite retry loop or a dropped write.
 */
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
import { createUpcasterRegistry } from "../src/upcaster.js";

let nextSeq = 0;

function envelope(
	type: string,
	data: JsonObject = {},
	overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
	nextSeq += 1;
	// SAFETY: this test helper supplies every required envelope field and JSON data.
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
	// SAFETY: every envelope in this test is created with JSON object data.
	return event.data as JsonObject;
}

/** A counting fold: each `item.Added` bumps the total by its amount. */
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
		// The seq becomes the caller's `expectedSeq` for its next append, so a
		// wrong one turns every subsequent write into a spurious conflict.
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

	test("the seq is the maximum, not the last value seen", () => {
		// A replay makes no ordering promise the fold can lean on; taking the last
		// event's seq from an out-of-order batch would hand back a stale
		// expectedSeq and lose the next append.
		const first = envelope("item.Added", { amount: 1 }, { seq: 9 });
		const second = envelope("item.Added", { amount: 1 }, { seq: 4 });
		expect(foldEvents([first, second], counting).seq).toBe(9);
	});

	test("the initial state is not mutated by a fold", () => {
		// The spec is often a module-level constant reused across folds; a fold
		// that mutated it would leak one aggregate's state into the next.
		const spec = { ...counting, initialState: { total: 0 } };
		foldEvents([envelope("item.Added", { amount: 5 })], spec);
		expect(spec.initialState).toEqual({ total: 0 });
	});

	test("the event handed to evolve is frozen", () => {
		// Read-only by contract. An evolve that could edit the envelope would
		// make the fold depend on evolve's side effects rather than the log.
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
		// Each call gets a clone, so an evolve that mutates in place cannot
		// retroactively change what an earlier step produced.
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
		// One poison body must not make an aggregate permanently unloadable.
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
		// The caller persists this as a fact; without the seq the fact cannot
		// neutralise anything, and without the reason nobody can diagnose it.
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
		// `item.Added` quarantines as `item.Quarantined`, so the fact lands in
		// the same family a reader is already subscribed to.
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
		// The property the whole design exists for. On replay the poison event is
		// skipped because a *fact* says so, not because it threw again.
		const poison = envelope("item.Added", { amount: 5 });
		const fact = envelope("item.Quarantined", { offendingSeq: poison.seq });
		const outcome = foldEvents([poison, fact], counting);
		expect(outcome.state).toEqual({ total: 0 });
		// And no *new* quarantine is raised — it was already neutralised.
		expect(outcome.quarantined).toEqual([]);
	});

	test("a quarantine fact appearing before its target still neutralises it", () => {
		// The neutralised seqs are collected in a first pass precisely so order
		// does not matter; a single-pass fold would miss a fact that arrived
		// first and re-apply the poison event.
		const poison = envelope("item.Added", { amount: 5 }, { seq: 20 });
		const fact = envelope(
			"item.Quarantined",
			{ offendingSeq: 20 },
			{ seq: 10 },
		);
		expect(foldEvents([fact, poison], counting).state).toEqual({ total: 0 });
	});

	test("a live fold and a replay with the fact reach the same state", () => {
		// Stated as one assertion because it is the actual contract: whatever the
		// live pass decided, the replay reproduces without re-judging.
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
		// The replay uses a fold that would *not* throw, to prove the skip comes
		// from the fact rather than from the body failing again.
		const replay = foldEvents([good, poison, fact], {
			initialState: { total: 0 },
			evolve: (state: { total: number }, event) => ({
				total: state.total + Number(dataOf(event).amount ?? 0),
			}),
		});
		expect(replay.state).toEqual(live.state);
	});

	test("quarantine facts are never folded as ordinary events", () => {
		// They are metadata about the stream, not part of the aggregate; folding
		// one would let a quarantine change the state it was meant to protect.
		const outcome = foldEvents(
			[envelope("item.Quarantined", { offendingSeq: 999, amount: 100 })],
			counting,
		);
		expect(outcome.state).toEqual({ total: 0 });
	});

	test("a quarantine fact with no numeric offendingSeq neutralises nothing", () => {
		// A malformed fact must not silently neutralise an arbitrary event —
		// better to fold the stream as written than to drop something at random.
		const outcome = foldEvents(
			[
				envelope("item.Quarantined", { offendingSeq: "not-a-number" }),
				envelope("item.Added", { amount: 7 }),
			],
			counting,
		);
		expect(outcome.state).toEqual({ total: 7 });
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
		// The record becomes an appended fact, so its seq has to be one the
		// stream has not used yet.
		const outcome = foldEvents([envelope("item.Added", {}, { seq: 50 })], {
			initialState: {},
			evolve: () => {
				throw new Error("boom");
			},
		});
		expect(outcome.quarantined[0]?.quarantineSeq).toBeGreaterThan(50);
	});
});

describe("upcasting on read", () => {
	function registry() {
		return createUpcasterRegistry();
	}

	test("an event of an unregistered type passes through untouched", () => {
		const event = envelope("item.Added", { amount: 1 });
		expect(registry().upcast(event)).toBe(event);
	});

	test("a single upcaster advances the event one version", () => {
		const r = registry().register("item.Added", 1, (data) => ({
			// SAFETY: the registry receives JSON event bodies at this boundary.
			...(data as JsonObject),
			amount: 10,
		}));
		const upcast = r.upcast(envelope("item.Added", { amount: 1 }));
		expect(upcast.v).toBe(2);
		expect(dataOf(upcast).amount).toBe(10);
	});

	test("a chain is applied end to end", () => {
		// Old events are never rewritten, so a reader has to walk every step from
		// the stored version up to current. Stopping early hands back a
		// half-migrated body.
		const r = registry()
			.register("item.Added", 1, (data) => ({
				// SAFETY: the registry receives JSON event bodies at this boundary.
				...(data as JsonObject),
				step: "v2",
			}))
			.register("item.Added", 2, (data) => ({
				// SAFETY: the registry receives JSON event bodies at this boundary.
				...(data as JsonObject),
				step: "v3",
			}))
			.register("item.Added", 3, (data) => ({
				// SAFETY: the registry receives JSON event bodies at this boundary.
				...(data as JsonObject),
				step: "v4",
			}));
		const upcast = r.upcast(envelope("item.Added", { step: "v1" }));
		expect(upcast.v).toBe(4);
		expect(dataOf(upcast).step).toBe("v4");
	});

	test("a chain with a gap stops at the gap", () => {
		// Pinned deliberately. Registering v1→v2 and v3→v4 but not v2→v3 leaves
		// the event at v2, silently: the registry has no way to know a step is
		// missing rather than simply being the end of the chain.
		const r = registry()
			.register("item.Added", 1, (data) => ({
				// SAFETY: the registry receives JSON event bodies at this boundary.
				...(data as JsonObject),
				at: 2,
			}))
			.register("item.Added", 3, (data) => ({
				// SAFETY: the registry receives JSON event bodies at this boundary.
				...(data as JsonObject),
				at: 4,
			}));
		const upcast = r.upcast(envelope("item.Added", { at: 1 }));
		expect(upcast.v).toBe(2);
		expect(dataOf(upcast).at).toBe(2);
	});

	test("an event already at the latest version is returned unchanged", () => {
		// Identity, not a copy: a reader comparing by reference must not see a
		// new object for an event nothing was done to.
		const r = registry().register("item.Added", 1, (data) => data);
		const event = envelope("item.Added", { amount: 1 }, { v: 5 });
		expect(r.upcast(event)).toBe(event);
	});

	test("upcasting starts from the event's own version, not from one", () => {
		// A v2 event must not be run through the v1 transform again — that would
		// apply a migration twice.
		const applied: number[] = [];
		const r = registry()
			.register("item.Added", 1, (data) => {
				applied.push(1);
				return data;
			})
			.register("item.Added", 2, (data) => {
				applied.push(2);
				return data;
			});
		r.upcast(envelope("item.Added", {}, { v: 2 }));
		expect(applied).toEqual([2]);
	});

	test("latestVersion reports the end of the chain", () => {
		const r = registry()
			.register("item.Added", 1, (d) => d)
			.register("item.Added", 2, (d) => d);
		expect(r.latestVersion("item.Added")).toBe(3);
	});

	test("latestVersion is one for a type with no upcasters", () => {
		// The first version of an event type is 1, so an unregistered type is
		// already current rather than unknown.
		expect(registry().latestVersion("never.Registered")).toBe(1);
	});

	test("latestVersion stops at a gap too", () => {
		const r = registry()
			.register("item.Added", 1, (d) => d)
			.register("item.Added", 3, (d) => d);
		expect(r.latestVersion("item.Added")).toBe(2);
	});

	test("registration is chainable", () => {
		const r = registry();
		expect(r.register("a", 1, (d) => d)).toBe(r);
	});

	test("a duplicate registration is refused", () => {
		// Two transforms for one step is ambiguous, and silently keeping either
		// would make the migration depend on module load order.
		const r = registry().register("item.Added", 1, (d) => d);
		expect(() => r.register("item.Added", 1, (d) => d)).toThrow(/duplicate/);
	});

	test("the same version for a different type is not a duplicate", () => {
		const r = registry().register("item.Added", 1, (d) => d);
		expect(() => r.register("other.Added", 1, (d) => d)).not.toThrow();
	});

	test("a non-function upcaster is refused", () => {
		expect(() =>
			// SAFETY: this negative test deliberately bypasses the typed API.
			registry().register("item.Added", 1, "not-a-function" as never),
		).toThrow(TypeError);
	});

	test("a non-positive or non-integer fromVersion is refused", () => {
		// Versions start at 1 and step by one; anything else would register a
		// transform the chain walk can never reach.
		for (const version of [0, -1, 1.5, Number.NaN]) {
			expect(() =>
				registry().register("item.Added", version, (d) => d),
			).toThrow(TypeError);
		}
	});

	test("upcasters run inside a fold", () => {
		// The end-to-end path: a stored v1 body is migrated on read and the fold
		// sees the current shape without the log having been rewritten.
		const upcasters = registry().register("item.Added", 1, (data) => ({
			// SAFETY: the registry receives JSON event bodies at this boundary.
			amount: Number((data as JsonObject).legacyAmount ?? 0),
		}));
		const outcome = foldEvents([envelope("item.Added", { legacyAmount: 7 })], {
			...counting,
			upcasters,
		});
		expect(outcome.state).toEqual({ total: 7 });
	});

	test("an upcaster that throws quarantines rather than wedging the fold", () => {
		// Regression. The upcast used to run *outside* the try/catch, so a
		// migration that threw propagated straight out of `foldEvents` — despite
		// the module's own contract saying "an evolve/upcast that throws in THIS
		// pass is recorded as a fresh quarantine record ... so one bad body never
		// wedges the stream".
		const upcasters = registry().register("item.Added", 1, () => {
			throw new Error("bad migration");
		});
		const outcome = foldEvents([envelope("item.Added", { amount: 1 })], {
			...counting,
			upcasters,
		});
		expect(outcome.quarantined).toHaveLength(1);
		expect(outcome.quarantined[0]?.reason).toBe("bad migration");
	});

	test("one bad migration does not stop the rest of the stream folding", () => {
		// The consequence that made the gap worth fixing rather than recording:
		// the aggregate was not merely missing one event, it was unloadable.
		const upcasters = registry().register("legacy.Added", 1, () => {
			throw new Error("bad migration");
		});
		const outcome = foldEvents(
			[
				envelope("item.Added", { amount: 1 }),
				envelope("legacy.Added", { amount: 99 }),
				envelope("item.Added", { amount: 2 }),
			],
			{ ...counting, upcasters },
		);
		expect(outcome.state).toEqual({ total: 3 });
		expect(outcome.quarantined).toHaveLength(1);
	});

	test("a failed migration is recoverable, because the fold can now produce its fact", () => {
		// And the reason it was permanent before: the quarantine fact that
		// neutralises the event can only be produced by a fold that finishes. A
		// throwing upcaster runs again on every replay, so a fold that died on it
		// could never emit the fact that would let the next replay skip it.
		const upcasters = registry().register("item.Added", 1, () => {
			throw new Error("bad migration");
		});
		const poison = envelope("item.Added", { amount: 5 });
		const live = foldEvents([poison], { ...counting, upcasters });
		expect(live.quarantined[0]?.offendingSeq).toBe(poison.seq);

		const fact = envelope("item.Quarantined", { offendingSeq: poison.seq });
		const replay = foldEvents([poison, fact], { ...counting, upcasters });
		expect(replay.quarantined).toEqual([]);
		expect(replay.state).toEqual({ total: 0 });
	});
});

describe("the typed errors", () => {
	test("an invariant violation is explicitly not retryable", () => {
		// The distinction a caller branches on. Retrying an illegal command is an
		// infinite loop; not retrying a conflict is a dropped write.
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
		// A stale fence means another actor took over the stream; retrying would
		// be one actor fighting another rather than resolving anything.
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
		// Callers use `instanceof Error` and read `.stack`; a plain object here
		// would break both.
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
		// The inward-only dependency rule means this package cannot import the
		// runtime's error class, so it matches on the shape instead. A rename on
		// either side silently breaks retry, which is why both names are pinned.
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
		// Treating an arbitrary failure as retryable would retry a command that
		// can never succeed.
		expect(isOptimisticConflict(new Error("disk full"))).toBe(false);
		expect(isOptimisticConflict(new AggregateInvariantError("x"))).toBe(false);
	});

	test("null and undefined are not conflicts", () => {
		// Reached from a `catch`, where the thrown value can be anything.
		expect(isOptimisticConflict(null)).toBe(false);
		expect(isOptimisticConflict(undefined)).toBe(false);
	});

	test("a stale fence is recognised by name or code", () => {
		expect(isStaleFenceError({ name: "StaleFenceError" })).toBe(true);
		expect(isStaleFenceError({ code: "STALE_FENCE" })).toBe(true);
		expect(isStaleFenceError(new AggregateStaleFenceError("s"))).toBe(true);
	});

	test("a conflict is not a stale fence", () => {
		// They call for opposite responses — retry versus stand down — so the two
		// predicates must not both answer true.
		expect(isStaleFenceError(new AggregateConflictError("s", 1))).toBe(false);
		expect(isOptimisticConflict(new AggregateStaleFenceError("s"))).toBe(false);
	});

	test("null and undefined are not stale fences", () => {
		expect(isStaleFenceError(null)).toBe(false);
		expect(isStaleFenceError(undefined)).toBe(false);
	});
});
