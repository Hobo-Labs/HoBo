/**
 * The deterministic queue-clock store — normalization, snapshots, and lease
 * eligibility.
 *
 * This store backs a *deterministic* clock: the same seed and the same
 * operations must produce the same trace on any machine, on any run. Every
 * design choice here follows from that.
 *
 * **A snapshot is restored, never merged.** Resuming with a seed that
 * disagrees with the snapshot's is a `NondeterministicClockError`, because the
 * seed is what makes the replay reproducible — continuing under a different
 * one would produce a trace that looks authoritative and is not.
 *
 * **Sequence counters are positive integers and `nowMs` is non-negative.** A
 * zero or fractional sequence would collide with, or sort ambiguously against,
 * the ids already issued. These are validated on restore rather than trusted,
 * because a snapshot is a document that may have been hand-edited or written
 * by another version.
 *
 * **Snapshots are deep-frozen clones.** The store keeps mutating after one is
 * taken, so a shallow reference would let later work rewrite a snapshot
 * someone is holding as a fixed point — and the freeze turns an accidental
 * mutation of a snapshot into a visible failure rather than silent drift.
 *
 * **Lease eligibility is deliberately conservative.** A message that is being
 * processed, already completed, not yet due, or holding a live lease is not
 * available. Handing out a second lease on a live one is a double-delivery,
 * which is the failure this predicate exists to prevent.
 */
import { NondeterministicClockError, QueueLeaseLostError } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	appendTrace,
	cloneStore,
	findMessageById,
	formatInstant,
	getQueue,
	isAvailableForLease,
	normalizeNonNegativeInteger,
	normalizePositiveInteger,
	normalizeStore,
	parseInstantMs,
	requireNonEmptyString,
	snapshotStore,
} from "../src/queue-clock-store.js";

/** A message record with the fields lease eligibility reads. */
function message(overrides: Record<string, unknown> = {}) {
	return {
		messageId: "m-1",
		state: "pending",
		processing: false,
		completedAtMs: null,
		availableAtMs: 0,
		leaseExpiresAtMs: null,
		...overrides,
	} as never;
}

describe("instant helpers", () => {
	it("formats a timestamp as ISO-8601", () => {
		expect(formatInstant(0)).toBe("1970-01-01T00:00:00.000Z");
	});

	it("round-trips through parse", () => {
		// The trace records both forms. Drift between them would make a replay
		// disagree with the timestamps it was built from.
		const ms = Date.UTC(2026, 5, 26);
		expect(parseInstantMs(formatInstant(ms), "at")).toBe(ms);
	});

	it("refuses an unparseable instant, naming the field", () => {
		// A `NaN` clock start would poison every later timestamp with `NaN`, and
		// nothing downstream would say which field it came from.
		for (const raw of ["", "yesterday", "2026-13-45"]) {
			expect(() => parseInstantMs(raw, "options.startInstant")).toThrow(
				/options\.startInstant/,
			);
		}
	});
});

describe("field validators", () => {
	it("requires a non-empty string", () => {
		expect(requireNonEmptyString("seed", "seed")).toBe("seed");
		for (const raw of ["", undefined, null, 7, {}]) {
			expect(() => requireNonEmptyString(raw, "seed")).toThrow(/seed/);
		}
	});

	it("requires a positive safe integer for sequence counters", () => {
		// Sequence counters name ids that have already been issued. A zero would
		// collide with the first one; a fraction would sort ambiguously.
		expect(normalizePositiveInteger(1, "seq")).toBe(1);
		expect(normalizePositiveInteger(42, "seq")).toBe(42);
		for (const raw of [
			0,
			-1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.MAX_SAFE_INTEGER + 2,
			"1",
			null,
			undefined,
		]) {
			expect(() => normalizePositiveInteger(raw, "seq"), String(raw)).toThrow(
				/seq/,
			);
		}
	});

	it("allows zero for a non-negative integer but nothing below it", () => {
		// `nowMs` legitimately starts at the epoch; a negative clock does not
		// exist and would make every duration comparison wrong.
		expect(normalizeNonNegativeInteger(0, "nowMs")).toBe(0);
		for (const raw of [-1, 0.5, Number.NaN, "0"]) {
			expect(() => normalizeNonNegativeInteger(raw, "nowMs")).toThrow(/nowMs/);
		}
	});
});

describe("cloneStore", () => {
	it("returns a structurally equal but independent copy", () => {
		// The store keeps mutating. A shared reference would let later work
		// rewrite a value the caller took as fixed.
		const original = { queues: { a: { messages: [1] } } };
		const copy = cloneStore(original);
		expect(copy).toEqual(original);
		expect(copy.queues).not.toBe(original.queues);
	});

	it("passes undefined through rather than cloning it", () => {
		// `structuredClone(undefined)` is fine, but the JSON fallback would turn
		// it into `undefined` via a throw. The short-circuit keeps both paths
		// agreeing.
		expect(cloneStore(undefined)).toBeUndefined();
	});
});

describe("appendTrace", () => {
	it("appends a frozen copy, not the caller's object", () => {
		// The trace is the deterministic record. A caller that kept a reference
		// and edited it later would rewrite history after the fact.
		const store = normalizeStore();
		const event = { type: "clock.tick", atMs: 1 } as never;
		appendTrace(store, event);
		const appended = store.trace[store.trace.length - 1] as Record<
			string,
			unknown
		>;
		expect(appended).not.toBe(event);
		expect(Object.isFrozen(appended)).toBe(true);
	});
});

describe("normalizeStore — fresh", () => {
	it("starts at the documented default seed and instant", () => {
		// The defaults are part of the determinism contract: a caller that
		// passes nothing must get the same clock every time.
		const store = normalizeStore();
		expect(store.seed).toBe("runtime-local-seed");
		expect(formatInstant(store.nowMs)).toBe("2026-06-26T00:00:00.000Z");
	});

	it("starts every sequence at one and every collection empty", () => {
		const store = normalizeStore();
		expect(store.nextMessageSeq).toBe(1);
		expect(store.nextLeaseSeq).toBe(1);
		expect(store.nextTimerSeq).toBe(1);
		expect(store.nextFireSeq).toBe(1);
		expect(store.queues).toEqual({});
		expect(store.timers).toEqual([]);
		expect(store.cronSchedules).toEqual([]);
	});

	it("records the start in the trace with both time forms", () => {
		// The trace is what a replay is checked against, and the very first
		// entry is what establishes the clock's origin.
		const store = normalizeStore({
			seed: "s",
			startInstant: "2026-01-01T00:00:00.000Z",
		});
		expect(store.trace).toHaveLength(1);
		const first = store.trace[0] as Record<string, unknown>;
		expect(first.type).toBe("clock.started");
		expect(first.seed).toBe("s");
		expect(first.atMs).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
		expect(first.at).toBeDefined();
	});

	it("refuses an empty seed", () => {
		// The seed drives every pseudo-random decision. An empty one would still
		// be deterministic but would make two differently-configured runs
		// indistinguishable in the trace.
		expect(() => normalizeStore({ seed: "" })).toThrow(/options\.seed/);
	});

	it("refuses an unparseable start instant", () => {
		expect(() => normalizeStore({ startInstant: "soon" })).toThrow(
			/options\.startInstant/,
		);
	});

	it("carries the port contract version", () => {
		// The version is how a reader of a snapshot knows which store wrote it.
		expect(normalizeStore().version).toBeTruthy();
	});
});

describe("normalizeStore — from a snapshot", () => {
	const base = () => snapshotStore(normalizeStore({ seed: "s" }));

	it("restores the snapshot's own state", () => {
		const snapshot = base();
		const restored = normalizeStore({ snapshot });
		expect(restored.seed).toBe("s");
		expect(restored.nowMs).toBe(snapshot.nowMs);
		expect(restored.nextMessageSeq).toBe(1);
	});

	it("does not append a start entry over the restored trace", () => {
		// Resuming is not starting. A second `clock.started` would make the
		// replay of a resumed run disagree with the original.
		const restored = normalizeStore({ snapshot: base() });
		expect(
			restored.trace.filter(
				(entry) => (entry as { type: string }).type === "clock.started",
			),
		).toHaveLength(1);
	});

	it("accepts a matching seed alongside the snapshot", () => {
		// Passing the seed you expect is a legitimate assertion, not a conflict.
		expect(normalizeStore({ snapshot: base(), seed: "s" }).seed).toBe("s");
	});

	it("refuses a seed that disagrees with the snapshot, naming both", () => {
		// This is the determinism guard. Continuing under a different seed would
		// produce a trace that looks authoritative and is not reproducible from
		// the snapshot it claims to continue.
		expect(() => normalizeStore({ snapshot: base(), seed: "other" })).toThrow(
			NondeterministicClockError,
		);
		expect(() => normalizeStore({ snapshot: base(), seed: "other" })).toThrow(
			/expected s, got other/,
		);
	});

	it("copies the snapshot rather than aliasing it", () => {
		// The restored store mutates immediately. Aliasing would rewrite the
		// snapshot the caller is still holding — and it is frozen, so the write
		// would throw somewhere unrelated.
		const snapshot = base();
		const restored = normalizeStore({ snapshot });
		expect(restored.queues).not.toBe(snapshot.queues);
		expect(Object.isFrozen(restored)).toBe(false);
	});

	it("refuses a snapshot whose seed is empty", () => {
		const snapshot = { ...base(), seed: "" } as never;
		expect(() => normalizeStore({ snapshot })).toThrow(/snapshot\.seed/);
	});

	it("refuses a snapshot whose counters are not positive integers", () => {
		// A snapshot is a document — hand-edited, or written by another version.
		// A zero counter would re-issue an id that already exists.
		for (const field of [
			"nextMessageSeq",
			"nextLeaseSeq",
			"nextTimerSeq",
			"nextFireSeq",
		]) {
			const snapshot = { ...base(), [field]: 0 } as never;
			expect(() => normalizeStore({ snapshot }), field).toThrow(
				new RegExp(`snapshot\\.${field}`),
			);
		}
	});

	it("refuses a snapshot whose nowMs is negative but allows zero", () => {
		expect(() =>
			normalizeStore({ snapshot: { ...base(), nowMs: -1 } as never }),
		).toThrow(/snapshot\.nowMs/);
		expect(
			normalizeStore({ snapshot: { ...base(), nowMs: 0 } as never }).nowMs,
		).toBe(0);
	});

	it("defaults the collections a snapshot omits", () => {
		// A snapshot written before a collection existed is still restorable;
		// `undefined` there would fail on the first push instead.
		const snapshot = {
			...base(),
			queues: undefined,
			timers: undefined,
			cronSchedules: undefined,
			trace: undefined,
		} as never;
		const restored = normalizeStore({ snapshot });
		expect(restored.queues).toEqual({});
		expect(restored.timers).toEqual([]);
		expect(restored.cronSchedules).toEqual([]);
		expect(restored.trace).toEqual([]);
	});

	it("stamps the current contract version rather than the snapshot's", () => {
		// The running store implements this version's semantics whatever the
		// document claimed, and saying otherwise would mislabel the next
		// snapshot.
		const snapshot = { ...base(), version: "ancient" } as never;
		expect(normalizeStore({ snapshot }).version).toBe(normalizeStore().version);
	});
});

describe("snapshotStore", () => {
	it("deep-freezes the result", () => {
		// A snapshot is a fixed point. Mutating one would make two readers of
		// "the same" snapshot disagree.
		const store = normalizeStore();
		getQueue(store, "orders");
		const snapshot = snapshotStore(store);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.queues)).toBe(true);
		expect(Object.isFrozen(snapshot.trace)).toBe(true);
	});

	it("is independent of later mutations to the store", () => {
		const store = normalizeStore();
		const snapshot = snapshotStore(store);
		getQueue(store, "added-later");
		expect(Object.keys(snapshot.queues)).toEqual([]);
		expect(Object.keys(store.queues)).toEqual(["added-later"]);
	});
});

describe("getQueue", () => {
	it("creates a queue on first reference and returns the same one after", () => {
		// Queues are implicit — a producer naming a new one should not have to
		// declare it first. Creating a fresh record each time would lose
		// messages.
		const store = normalizeStore();
		const first = getQueue(store, "orders");
		first.messages.push(message());
		expect(getQueue(store, "orders")).toBe(first);
		expect(getQueue(store, "orders").messages).toHaveLength(1);
	});

	it("names the queue on the record it creates", () => {
		expect(getQueue(normalizeStore(), "orders").name).toBe("orders");
	});

	it("refuses an empty queue name", () => {
		// An unnamed queue would collect messages nobody can address.
		expect(() => getQueue(normalizeStore(), "")).toThrow(/queueName/);
	});
});

describe("findMessageById", () => {
	it("finds a message in any queue", () => {
		// Message ids are global, so a lookup must not require the caller to
		// also know which queue it landed in.
		const store = normalizeStore();
		getQueue(store, "a").messages.push(message({ messageId: "m-a" }));
		getQueue(store, "b").messages.push(message({ messageId: "m-b" }));
		expect(findMessageById(store, "m-b").messageId).toBe("m-b");
	});

	it("throws a lease-lost error for an unknown id", () => {
		// The caller is almost always a worker completing or extending a lease.
		// "Lease lost" is the accurate framing: the message it held is gone.
		expect(() => findMessageById(normalizeStore(), "m-404")).toThrow(
			QueueLeaseLostError,
		);
		expect(() => findMessageById(normalizeStore(), "m-404")).toThrow(/m-404/);
	});

	it("refuses an empty id before searching", () => {
		expect(() => findMessageById(normalizeStore(), "")).toThrow(/messageId/);
	});
});

describe("isAvailableForLease", () => {
	it("offers a pending message that is due", () => {
		expect(isAvailableForLease(message({ availableAtMs: 100 }), 100)).toBe(
			true,
		);
	});

	it("withholds a message that is not yet due", () => {
		// Scheduled delivery is the whole point of `availableAtMs`. Leasing
		// early would deliver a message before the time the producer asked for.
		expect(isAvailableForLease(message({ availableAtMs: 101 }), 100)).toBe(
			false,
		);
	});

	it("withholds a message currently being processed", () => {
		// In-flight work holds the message. A second lease here is a
		// double-delivery, which is exactly what this predicate prevents.
		expect(isAvailableForLease(message({ processing: true }), 100)).toBe(false);
	});

	it("withholds a completed message", () => {
		// Re-leasing completed work would re-run a side effect that already
		// happened.
		expect(
			isAvailableForLease(
				message({ state: "completed", completedAtMs: 50 }),
				100,
			),
		).toBe(false);
	});

	it("withholds a leased message whose lease has not expired", () => {
		expect(
			isAvailableForLease(
				message({ state: "leased", leaseExpiresAtMs: 101 }),
				100,
			),
		).toBe(false);
	});

	it("offers a leased message once its lease has expired", () => {
		// An expired lease means the worker is presumed gone. Not re-offering it
		// would strand the message forever.
		expect(
			isAvailableForLease(
				message({ state: "leased", leaseExpiresAtMs: 100 }),
				100,
			),
		).toBe(true);
	});

	it("withholds a leased message with no expiry recorded", () => {
		// A lease with no deadline cannot be shown to have expired. Offering it
		// would double-deliver on the strength of a missing field.
		expect(
			isAvailableForLease(
				message({ state: "leased", leaseExpiresAtMs: null }),
				100,
			),
		).toBe(false);
	});

	it("withholds a message in a state it does not recognise", () => {
		// Only `pending` and an expired `leased` are offerable. A future state
		// defaulting to available would deliver messages the new code meant to
		// hold.
		expect(isAvailableForLease(message({ state: "dead-lettered" }), 100)).toBe(
			false,
		);
	});

	it("offers a completed-timestamped message whose state disagrees", () => {
		// The completed check requires *both* the timestamp and the state. A
		// record with only one is inconsistent, and treating it as complete
		// would silently drop work that was never finished. Pinned as-is.
		expect(
			isAvailableForLease(
				message({ state: "pending", completedAtMs: 50 }),
				100,
			),
		).toBe(true);
	});
});
