import { parseRunId } from "@hobo/core";
import { createLocalStreamer } from "@hobo/runtime-local";
import { describe, expect, it } from "vitest";
import {
	createOptimisticSubscription,
	createReactor,
	defineMaterialization,
	type MaterializedFrame,
	OptimisticSeqRegressionError,
	parseOptimisticSequence,
} from "../src/index.js";
import { CTX, freshStore } from "./helpers.js";

function frame<T>(value: T, seq: number, streamSeqs: Record<string, number>) {
	return { value, seq, streamSeqs };
}

describe("optimistic subscriptions", () => {
	it("parses sequence vectors into independent ordered values", () => {
		const input = { z: 4, a: 1 };
		const parsed = parseOptimisticSequence(input);
		input.a = 9;
		expect(Object.entries(parsed)).toEqual([
			["a", 1],
			["z", 4],
		]);
		expect(Object.isFrozen(parsed)).toBe(true);
		for (const invalid of [
			null,
			[],
			{ " ": 1 },
			{ a: -1 },
			{ a: 1.5 },
			{ a: "1" },
		])
			expect(() => parseOptimisticSequence(invalid)).toThrow(TypeError);
	});

	it("reconciles a speculative command with a real Reactor frame", async () => {
		const store = freshStore();
		const streamer = createLocalStreamer();
		const reactor = createReactor({ store, streamer });
		const materialization = defineMaterialization<string[]>({
			name: "titles",
			readSet: ["note.Added"],
			initialState: [],
			fold: (state, event) => [...state, String(event.data.title)],
		});
		const sub = await reactor.subscribe(materialization, {
			subscriptionId: "sub:notes",
		});
		const reader = streamer
			.getRun<MaterializedFrame<string[]>>(parseRunId("sub:notes"))
			.readable[Symbol.asyncIterator]();
		try {
			const client = createOptimisticSubscription({
				subscriptionId: "sub:notes",
				initial: frame<string[]>([], 0, {}),
			});
			expect(
				client.applyOptimisticPatch({
					commandId: "add-note",
					seqFloor: { "note:1": 1 },
					apply: (notes) => [...notes, "hello"],
				}),
			).toMatchObject({
				value: ["hello"],
				seq: 0,
				streamSeqs: {},
				optimistic: true,
				stale: true,
			});
			await store.append(
				"note:1",
				[{ type: "note.Added", data: { title: "hello" } }],
				{ ...CTX, expectedSeq: 0 },
			);
			const pushed = await reader.next();
			if (!pushed.value) throw new Error("missing Reactor frame");
			expect(client.receiveAuthoritativePush(pushed.value.chunk)).toEqual({
				value: ["hello"],
				seq: 1,
				streamSeqs: { "note:1": 1 },
				stale: false,
				optimistic: false,
				pendingCommands: [],
			});
			expect(client.auditLog().map((entry) => entry.type)).toEqual([
				"optimistic.Applied",
				"optimistic.Reconciled",
			]);
		} finally {
			await reader.return?.();
			sub.close();
			store.close();
		}
	});

	it("orders dependent patches and retains submission order for independent streams", () => {
		const client = createOptimisticSubscription({
			subscriptionId: "sub:order",
			initial: frame("", 0, {}),
		});
		client.applyOptimisticPatch({
			commandId: "later",
			seqFloor: { a: 2 },
			apply: (value) => `${value}2`,
		});
		client.applyOptimisticPatch({
			commandId: "independent",
			seqFloor: { b: 1 },
			apply: (value) => `${value}b`,
		});
		const view = client.applyOptimisticPatch({
			commandId: "earlier",
			seqFloor: { a: 1 },
			apply: (value) => `${value}1`,
		});
		expect(view.value).toBe("b12");
		expect(view.pendingCommands).toEqual(["independent", "earlier", "later"]);
		expect(client.rejectCommand("independent", "denied").value).toBe("12");
		expect(
			client.receiveAuthoritativePush(frame("1", 1, { a: 1 })),
		).toMatchObject({
			value: "12",
			seq: 1,
			pendingCommands: ["later"],
		});
	});

	it("rejects missing or regressing positions without changing the view", () => {
		const client = createOptimisticSubscription({
			subscriptionId: "sub:counter",
			initial: frame({ count: 3 }, 3, { counter: 3 }),
		});
		client.applyOptimisticPatch({
			commandId: "increment",
			seqFloor: { counter: 4 },
			apply: ({ count }) => ({ count: count + 1 }),
		});
		const before = client.current();
		for (const next of [
			frame({ count: 2 }, 2, { counter: 2 }),
			frame({ count: 4 }, 4, {}),
		])
			expect(() => client.receiveAuthoritativePush(next)).toThrow(
				OptimisticSeqRegressionError,
			);
		expect(() => client.rejectCommand("increment", " ")).toThrow(/reason/);
		expect(client.current()).toEqual(before);
		expect(client.auditLog()).toHaveLength(1);
	});

	it("does not commit a failed patch or failed reapplication", () => {
		const client = createOptimisticSubscription({
			subscriptionId: "sub:atomic",
			initial: frame({ value: 0 }, 0, {}),
		});
		expect(() =>
			client.applyOptimisticPatch({
				commandId: "broken",
				seqFloor: { stream: 1 },
				apply: () => {
					throw new Error("broken patch");
				},
			}),
		).toThrow("broken patch");
		expect(client.current().pendingCommands).toEqual([]);
		expect(client.auditLog()).toEqual([]);
		client.applyOptimisticPatch({
			commandId: "positive-only",
			seqFloor: { stream: 2 },
			apply: (state) => {
				if (state.value < 0) throw new Error("negative state");
				return { value: state.value + 1 };
			},
		});
		const before = client.current();
		expect(() =>
			client.receiveAuthoritativePush(frame({ value: -1 }, 1, { stream: 1 })),
		).toThrow("negative state");
		expect(client.current()).toEqual(before);
		expect(client.auditLog()).toHaveLength(1);
	});

	it("ignores an already observed command and isolates returned values", () => {
		const initial = frame({ value: 1 }, 1, { stream: 1 });
		const client = createOptimisticSubscription({
			subscriptionId: "sub:observed",
			initial,
		});
		initial.value.value = 9;
		const observed = client.applyOptimisticPatch({
			commandId: "seen",
			seqFloor: { stream: 1 },
			apply: () => {
				throw new Error("already satisfied patches must not execute");
			},
		});
		observed.value.value = 7;
		expect(client.current().value).toEqual({ value: 1 });
		expect(client.auditLog()[0]?.type).toBe("optimistic.AlreadySatisfied");
		expect(() =>
			client.applyOptimisticPatch({
				commandId: "empty",
				seqFloor: {},
				apply: (v) => v,
			}),
		).toThrow(/at least one stream/);
	});

	it("preserves authoritative freshness across reconciliation", () => {
		const client = createOptimisticSubscription({
			subscriptionId: "sub:freshness",
			initial: { ...frame("old", 1, { note: 1 }), stale: true },
		});
		expect(client.current()).toMatchObject({ stale: true, optimistic: false });
		client.applyOptimisticPatch({
			commandId: "edit",
			seqFloor: { note: 2 },
			apply: () => "new",
		});
		expect(
			client.receiveAuthoritativePush({
				...frame("new", 2, { note: 2 }),
				stale: true,
			}),
		).toMatchObject({ stale: true, optimistic: false });
		expect(
			client.receiveAuthoritativePush(frame("new", 2, { note: 2 })),
		).toMatchObject({
			stale: false,
			optimistic: false,
		});
	});
});
