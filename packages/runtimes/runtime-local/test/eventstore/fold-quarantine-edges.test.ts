import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppendOptions, FoldHandlers } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	collectStream,
	createManualClock,
	createRuntimeLocalEventStore,
} from "../../src/index.js";
import { isJsonObject, isJsonString, type JsonValue } from "../../src/json.js";

function storeForTest() {
	const dataDir = mkdtempSync(join(tmpdir(), "hobo-es-fold-"));
	const clock = createManualClock("2026-06-26T00:00:00.000Z");
	return createRuntimeLocalEventStore({ dataDir, clock });
}

const APPEND = {
	expectedSeq: 0,
	actor: { kind: "system", id: "runtime-local" },
	tenant: "tenant-a",
} as const;

async function poisonedStream(
	store: ReturnType<typeof createRuntimeLocalEventStore>,
	options: { correlationId?: string } = {},
) {
	const append: AppendOptions = { ...APPEND };
	if (options.correlationId !== undefined)
		append.correlationId = options.correlationId;
	await store.append(
		"ticket:1",
		[
			{ type: "ticket.Opened", data: { title: "Login" } },
			{ type: "ticket.Opened", data: {} },
			{ type: "ticket.Commented", data: { text: "after" } },
		],
		append,
	);
	return store;
}

type TicketState = { title: string; comments: number };

const HANDLERS: FoldHandlers<TicketState> = {
	"ticket.Opened": (state, event) => {
		if (!isJsonObject(event.data) || !isJsonString(event.data.title))
			throw new Error("title is required");
		return { ...state, title: event.data.title };
	},
	"ticket.Commented": (state) => ({
		...state,
		comments: state.comments + 1,
	}),
};

const fold = (store: ReturnType<typeof createRuntimeLocalEventStore>) =>
	store.fold("ticket:1", {
		initialState: { title: "", comments: 0 },
		handlers: HANDLERS,
	});

describe("folding the same stream twice", () => {
	it("quarantines the poison event once", async () => {
		const store = await poisonedStream(storeForTest());
		await fold(store);
		await fold(store);
		const markers = (await collectStream(store, "ticket:1")).filter((event) =>
			event.type.endsWith(".Quarantined"),
		);
		expect(markers).toHaveLength(1);
		store.close();
	});

	it("reports the same quarantine on every fold", async () => {
		const store = await poisonedStream(storeForTest());
		const first = await fold(store);
		expect((await fold(store)).quarantined).toStrictEqual(first.quarantined);
		store.close();
	});

	it("does not re-quarantine after a restart", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "hobo-es-fold-restart-"));
		const open = () =>
			createRuntimeLocalEventStore({
				dataDir,
				clock: createManualClock("2026-06-26T00:00:00.000Z"),
			});
		const first = await poisonedStream(open());
		await fold(first);
		first.close();

		const second = open();
		await fold(second);
		const markers = (await collectStream(second, "ticket:1")).filter((event) =>
			event.type.endsWith(".Quarantined"),
		);
		expect(markers).toHaveLength(1);
		second.close();
	});

	it("still reports the same quarantine after a restart", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "hobo-es-fold-restart-"));
		const open = () =>
			createRuntimeLocalEventStore({
				dataDir,
				clock: createManualClock("2026-06-26T00:00:00.000Z"),
			});
		const first = await poisonedStream(open());
		const before = await fold(first);
		first.close();

		const second = open();
		const after = await fold(second);
		expect(after.quarantined).toHaveLength(1);
		expect(after.quarantined[0]?.offendingSeq).toBe(
			before.quarantined[0]?.offendingSeq,
		);
		expect(after.quarantined[0]?.quarantineSeq).toBe(
			before.quarantined[0]?.quarantineSeq,
		);
		second.close();
	});

	it("reaches the same state both times", async () => {
		const store = await poisonedStream(storeForTest());
		const first = await fold(store);
		const second = await fold(store);
		expect(second.state).toStrictEqual(first.state);
		store.close();
	});

	it("never feeds the quarantine marker to a handler", async () => {
		const store = await poisonedStream(storeForTest());
		await fold(store);
		const seen: string[] = [];
		await store.fold("ticket:1", {
			initialState: null,
			handlers: {
				"ticket.Quarantined": (state, event) => {
					seen.push(event.type);
					return state;
				},
			},
		});
		expect(seen).toStrictEqual([]);
		store.close();
	});

	it("names the quarantine after the offending event's aggregate", async () => {
		const store = await poisonedStream(storeForTest());
		const result = await fold(store);
		expect(result.quarantined[0]?.type).toBe("ticket.Quarantined");
		store.close();
	});

	it("carries the handler's own message as the reason", async () => {
		const store = await poisonedStream(storeForTest());
		const result = await fold(store);
		expect(result.quarantined[0]?.reason).toMatch(/title is required/);
		store.close();
	});

	it("carries the offending event's correlation id onto the marker", async () => {
		const store = await poisonedStream(storeForTest(), {
			correlationId: "trace-1",
		});
		await fold(store);
		const marker = (await collectStream(store, "ticket:1")).find((event) =>
			event.type.endsWith(".Quarantined"),
		);
		expect(marker?.correlationId).toBe("trace-1");
		store.close();
	});

	it("applies every non-poison event either way", async () => {
		const store = await poisonedStream(storeForTest());
		const result = await fold(store);
		expect(result.state).toStrictEqual({ title: "Login", comments: 1 });
		store.close();
	});
});

describe("handlers the fold refuses", () => {
	const foldWith = async (handlers: JsonValue) => {
		const store = storeForTest();
		try {
			return await store.fold("ticket:1", {
				initialState: {},
				handlers: JSON.parse(JSON.stringify(handlers)),
			});
		} finally {
			store.close();
		}
	};

	it("refuses an array", async () => {
		await expect(foldWith([])).rejects.toThrow(
			/foldOptions.handlers must be an object/,
		);
	});

	it("refuses null", async () => {
		await expect(foldWith(null)).rejects.toThrow(TypeError);
	});

	it("refuses a string", async () => {
		await expect(foldWith("ticket.Opened")).rejects.toThrow(TypeError);
	});

	it("accepts an empty object", async () => {
		await expect(foldWith({})).resolves.toMatchObject({ state: {} });
	});

	it("ignores an entry whose value is not a function", async () => {
		const store = await poisonedStream(storeForTest());
		const handlers = { ...HANDLERS };
		Reflect.set(handlers, "ticket.Archived", "not a function");
		const result = await store.fold("ticket:1", {
			initialState: { title: "", comments: 0 },
			handlers,
		});
		expect(result.state).toStrictEqual({ title: "Login", comments: 1 });
		store.close();
	});

	it("skips an event type no handler claims", async () => {
		const store = await poisonedStream(storeForTest());
		const result = await store.fold("ticket:1", {
			initialState: { title: "", comments: 0 },
			handlers: { "ticket.Commented": HANDLERS["ticket.Commented"] },
		});
		expect(result.state).toStrictEqual({ title: "", comments: 1 });
		store.close();
	});
});

describe("the initial state", () => {
	it("is required", async () => {
		await expect(
			storeForTest().fold("ticket:1", {
				initialState: undefined,
				handlers: {},
			}),
		).rejects.toThrow(/foldOptions.initialState is required/);
	});

	it("accepts null, which is a state", async () => {
		await expect(
			storeForTest().fold("ticket:1", { initialState: null, handlers: {} }),
		).resolves.toMatchObject({ state: null });
	});

	it("is copied, so the caller's object is not folded in place", async () => {
		const store = await poisonedStream(storeForTest());
		const initialState = { title: "", comments: 0 };
		await store.fold("ticket:1", {
			initialState,
			handlers: HANDLERS,
		});
		expect(initialState).toStrictEqual({ title: "", comments: 0 });
		store.close();
	});
});

describe("what a handler is handed", () => {
	it("cannot reach the stored event by mutating its argument", async () => {
		const store = await poisonedStream(storeForTest());
		await store.fold("ticket:1", {
			initialState: null,
			handlers: {
				"ticket.Commented": (state, event) => {
					if (!isJsonObject(event.data)) throw new Error("expected event data");
					Reflect.set(event.data, "text", "clobbered");
					return state;
				},
			},
		});
		const commented = (await collectStream(store, "ticket:1")).find(
			(event) => event.type === "ticket.Commented",
		);
		expect(commented?.data).toStrictEqual({ text: "after" });
		store.close();
	});

	it("reports the stream length as the folded sequence", async () => {
		const store = await poisonedStream(storeForTest());
		const result = await fold(store);
		const events = await collectStream(store, "ticket:1");
		expect(result.seq).toBe(events.length);
		store.close();
	});

	it("returns a frozen result", async () => {
		const store = await poisonedStream(storeForTest());
		expect(Object.isFrozen(await fold(store))).toBe(true);
		store.close();
	});

	it("reports no quarantines for a clean stream", async () => {
		const store = storeForTest();
		await store.append(
			"ticket:1",
			[{ type: "ticket.Opened", data: { title: "Login" } }],
			APPEND,
		);
		const result = await fold(store);
		expect(result.quarantined).toStrictEqual([]);
		store.close();
	});
});
