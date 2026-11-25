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
		const ms = Date.UTC(2026, 5, 26);
		expect(parseInstantMs(formatInstant(ms), "at")).toBe(ms);
	});

	it("refuses an unparseable instant, naming the field", () => {
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
		expect(normalizeNonNegativeInteger(0, "nowMs")).toBe(0);
		for (const raw of [-1, 0.5, Number.NaN, "0"]) {
			expect(() => normalizeNonNegativeInteger(raw, "nowMs")).toThrow(/nowMs/);
		}
	});
});

describe("cloneStore", () => {
	it("returns a structurally equal but independent copy", () => {
		const original = { queues: { a: { messages: [1] } } };
		const copy = cloneStore(original);
		expect(copy).toEqual(original);
		expect(copy.queues).not.toBe(original.queues);
	});

	it("passes undefined through rather than cloning it", () => {
		expect(cloneStore(undefined)).toBeUndefined();
	});
});

describe("appendTrace", () => {
	it("appends a frozen copy, not the caller's object", () => {
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
		expect(() => normalizeStore({ seed: "" })).toThrow(/options\.seed/);
	});

	it("refuses an unparseable start instant", () => {
		expect(() => normalizeStore({ startInstant: "soon" })).toThrow(
			/options\.startInstant/,
		);
	});

	it("carries the port contract version", () => {
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
		const restored = normalizeStore({ snapshot: base() });
		expect(
			restored.trace.filter(
				(entry) => (entry as { type: string }).type === "clock.started",
			),
		).toHaveLength(1);
	});

	it("accepts a matching seed alongside the snapshot", () => {
		expect(normalizeStore({ snapshot: base(), seed: "s" }).seed).toBe("s");
	});

	it("refuses a seed that disagrees with the snapshot, naming both", () => {
		expect(() => normalizeStore({ snapshot: base(), seed: "other" })).toThrow(
			NondeterministicClockError,
		);
		expect(() => normalizeStore({ snapshot: base(), seed: "other" })).toThrow(
			/expected s, got other/,
		);
	});

	it("copies the snapshot rather than aliasing it", () => {
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
		const snapshot = { ...base(), version: "ancient" } as never;
		expect(normalizeStore({ snapshot }).version).toBe(normalizeStore().version);
	});
});

describe("snapshotStore", () => {
	it("deep-freezes the result", () => {
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
		expect(() => getQueue(normalizeStore(), "")).toThrow(/queueName/);
	});
});

describe("findMessageById", () => {
	it("finds a message in any queue", () => {
		const store = normalizeStore();
		getQueue(store, "a").messages.push(message({ messageId: "m-a" }));
		getQueue(store, "b").messages.push(message({ messageId: "m-b" }));
		expect(findMessageById(store, "m-b").messageId).toBe("m-b");
	});

	it("throws a lease-lost error for an unknown id", () => {
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
		expect(isAvailableForLease(message({ availableAtMs: 101 }), 100)).toBe(
			false,
		);
	});

	it("withholds a message currently being processed", () => {
		expect(isAvailableForLease(message({ processing: true }), 100)).toBe(false);
	});

	it("withholds a completed message", () => {
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
		expect(
			isAvailableForLease(
				message({ state: "leased", leaseExpiresAtMs: 100 }),
				100,
			),
		).toBe(true);
	});

	it("withholds a leased message with no expiry recorded", () => {
		expect(
			isAvailableForLease(
				message({ state: "leased", leaseExpiresAtMs: null }),
				100,
			),
		).toBe(false);
	});

	it("withholds a message in a state it does not recognise", () => {
		expect(isAvailableForLease(message({ state: "dead-lettered" }), 100)).toBe(
			false,
		);
	});

	it("offers a completed-timestamped message whose state disagrees", () => {
		expect(
			isAvailableForLease(
				message({ state: "pending", completedAtMs: 50 }),
				100,
			),
		).toBe(true);
	});
});
