/**
 * Folding a stream that contains a poison event, and folding it again.
 *
 * `eventstore.test.ts` proves the headline behaviour: a handler that throws
 * does not wedge the fold — the offending event is quarantined and the rest of
 * the stream still applies. This covers the edges around that, and the one
 * that matters most is **the second fold**.
 *
 * Quarantining writes a `*.Quarantined` event back to the same stream. So a
 * fold is not a read-only operation, and running it twice is the ordinary
 * case — a projection rebuild, a replica catching up, an operator re-running a
 * report. If the second fold re-quarantined the same event, every rebuild
 * would append another marker and the stream would grow without bound while
 * the underlying poison stayed exactly as poisonous. Instead the marker is
 * found and reused, and the quarantine event itself is skipped rather than
 * fed to a handler that has no idea what it is.
 *
 * The rest is about refusing early and clearly:
 *
 * **Handlers must be an object.** An array or a string reaches
 * `Object.entries` without complaint and yields a fold that silently applies
 * nothing — a projection returning its initial state looks like a stream with
 * no events, which is the hardest kind of wrong answer to notice.
 *
 * **An absent initial state is refused, not defaulted.** `undefined` is not a
 * state a projection can fold onto, and defaulting it to `{}` or `null` would
 * pick a shape the caller's handlers were not written for.
 *
 * **Handlers see copies.** State and event are cloned in and the result is
 * cloned out, so a handler that mutates its arguments — the commonest
 * accidental way to write one — cannot reach back into the store's events or
 * into the state of an earlier step.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	collectStream,
	createManualClock,
	createRuntimeLocalEventStore,
} from "../../src/index.js";

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

/** A stream whose second event poisons any handler that reads `title`. */
async function poisonedStream(
	store: ReturnType<typeof createRuntimeLocalEventStore>,
	options: { correlationId?: string } = {},
) {
	await store.append(
		"ticket:1",
		[
			{ type: "ticket.Opened", data: { title: "Login" } },
			{ type: "ticket.Opened", data: {} },
			{ type: "ticket.Commented", data: { text: "after" } },
		],
		{
			...APPEND,
			...(options.correlationId !== undefined
				? { correlationId: options.correlationId }
				: {}),
		},
	);
	return store;
}

const HANDLERS = {
	"ticket.Opened": (
		state: { title: string; comments: number },
		event: never,
	) => {
		// SAFETY: the fixture writes exactly this shape.
		const data = (event as { data: { title?: string } }).data;
		if (typeof data.title !== "string") throw new Error("title is required");
		return { ...state, title: data.title };
	},
	"ticket.Commented": (state: { title: string; comments: number }) => ({
		...state,
		comments: state.comments + 1,
	}),
};

const fold = (store: ReturnType<typeof createRuntimeLocalEventStore>) =>
	store.fold("ticket:1", {
		initialState: { title: "", comments: 0 },
		handlers: HANDLERS as never,
	});

describe("folding the same stream twice", () => {
	it("quarantines the poison event once", async () => {
		// A fold is not read-only — it appends a marker. A rebuild that
		// re-quarantined would grow the stream on every run while the poison
		// stayed exactly as poisonous.
		const store = await poisonedStream(storeForTest());
		await fold(store);
		await fold(store);
		const markers = (await collectStream(store, "ticket:1")).filter((event) =>
			event.type.endsWith(".Quarantined"),
		);
		expect(markers).toHaveLength(1);
		store.close();
	});

	it("GAP: reports no quarantine on a second fold in the same process", async () => {
		// Pinned, not asserted as desirable. Within one store instance the
		// offending event is skipped outright on the second pass, so the fold
		// returns `quarantined: []` — and an operator re-running a rebuild
		// reads that as a clean stream. The marker is still in the stream, so
		// the information is not lost, but the fold result no longer surfaces
		// it. Changing that means deciding whether a skipped event should
		// re-report, which is a behaviour change for every caller of `fold`.
		const store = await poisonedStream(storeForTest());
		await fold(store);
		expect((await fold(store)).quarantined).toStrictEqual([]);
		store.close();
	});

	it("does not re-quarantine after a restart", async () => {
		// The in-memory set does not survive a restart, so this is the case
		// that decides whether repeated rebuilds grow the stream. No second
		// marker is appended: the scan finds the existing one and reuses it.
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
		// Reusing the marker must not mean losing the report: a fresh process
		// rebuilding a projection has to be told the stream has poison in it,
		// and has to be pointed at the same marker as the run before it.
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
		// The point of quarantining rather than throwing: the fold is
		// deterministic across rebuilds even with poison in the stream.
		const store = await poisonedStream(storeForTest());
		const first = await fold(store);
		const second = await fold(store);
		expect(second.state).toStrictEqual(first.state);
		store.close();
	});

	it("never feeds the quarantine marker to a handler", async () => {
		// The marker is bookkeeping, not domain history. A handler registered
		// for its type would be applying an event the domain never emitted.
		const store = await poisonedStream(storeForTest());
		await fold(store);
		const seen: string[] = [];
		await store.fold("ticket:1", {
			initialState: null,
			handlers: {
				"ticket.Quarantined": (state: null, event: never) => {
					// SAFETY: the fold hands the handler its envelope.
					seen.push((event as { type: string }).type);
					return state;
				},
			} as never,
		});
		expect(seen).toStrictEqual([]);
		store.close();
	});

	it("names the quarantine after the offending event's aggregate", async () => {
		// `ticket.Opened` quarantines as `ticket.Quarantined`, so the marker
		// sorts and filters with the aggregate it belongs to rather than
		// landing in a global bucket.
		const store = await poisonedStream(storeForTest());
		const result = await fold(store);
		expect(result.quarantined[0]?.type).toBe("ticket.Quarantined");
		store.close();
	});

	it("carries the handler's own message as the reason", async () => {
		// The reason is what an operator reads first. A generic "handler
		// failed" would send them to the logs for something already known here.
		const store = await poisonedStream(storeForTest());
		const result = await fold(store);
		expect(result.quarantined[0]?.reason).toMatch(/title is required/);
		store.close();
	});

	it("carries the offending event's correlation id onto the marker", async () => {
		// The marker belongs to the same trace as the event that caused it;
		// dropping the correlation would orphan it from the work being traced.
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
	const foldWith = (handlers: unknown) =>
		storeForTest().fold("ticket:1", {
			initialState: {},
			handlers: handlers as never,
		});

	it("refuses an array", async () => {
		// `Object.entries` accepts it and yields index keys, so the fold would
		// silently apply nothing — a projection returning its initial state
		// looks exactly like a stream with no events.
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
		// Registering no handlers is legitimate — a fold used only to surface
		// quarantines, or a projection not yet written.
		await expect(foldWith({})).resolves.toMatchObject({ state: {} });
	});

	it("ignores an entry whose value is not a function", async () => {
		// Refusing the whole map would make one stray config value break every
		// other handler in it; ignoring the entry leaves the rest working and
		// the unhandled type simply unhandled.
		const store = await poisonedStream(storeForTest());
		const result = await store.fold("ticket:1", {
			initialState: { title: "", comments: 0 },
			handlers: {
				...HANDLERS,
				"ticket.Archived": "not a function",
			} as never,
		});
		expect(result.state).toStrictEqual({ title: "Login", comments: 1 });
		store.close();
	});

	it("skips an event type no handler claims", async () => {
		const store = await poisonedStream(storeForTest());
		const result = await store.fold("ticket:1", {
			initialState: { title: "", comments: 0 },
			handlers: { "ticket.Commented": HANDLERS["ticket.Commented"] } as never,
		});
		expect(result.state).toStrictEqual({ title: "", comments: 1 });
		store.close();
	});
});

describe("the initial state", () => {
	it("is required", async () => {
		// `undefined` is not a state to fold onto, and defaulting it would pick
		// a shape the caller's handlers were not written for.
		await expect(
			storeForTest().fold("ticket:1", {
				initialState: undefined,
				handlers: {},
			}),
		).rejects.toThrow(/foldOptions.initialState is required/);
	});

	it("accepts null, which is a state", async () => {
		// Distinct from absent: a projection legitimately starting at null.
		await expect(
			storeForTest().fold("ticket:1", { initialState: null, handlers: {} }),
		).resolves.toMatchObject({ state: null });
	});

	it("is copied, so the caller's object is not folded in place", async () => {
		// A fold that mutated its argument would give a caller reusing one
		// initial state across two folds the second one's result in the first.
		const store = await poisonedStream(storeForTest());
		const initialState = { title: "", comments: 0 };
		await store.fold("ticket:1", {
			initialState,
			handlers: HANDLERS as never,
		});
		expect(initialState).toStrictEqual({ title: "", comments: 0 });
		store.close();
	});
});

describe("what a handler is handed", () => {
	it("cannot reach the stored event by mutating its argument", async () => {
		// Handlers are the commonest place to accidentally mutate. A shared
		// event object would let one projection corrupt the input of the next.
		const store = await poisonedStream(storeForTest());
		await store.fold("ticket:1", {
			initialState: null,
			handlers: {
				"ticket.Commented": (state: null, event: never) => {
					// SAFETY: the fold hands the handler its envelope.
					(event as { data: Record<string, unknown> }).data.text = "clobbered";
					return state;
				},
			} as never,
		});
		const commented = (await collectStream(store, "ticket:1")).find(
			(event) => event.type === "ticket.Commented",
		);
		expect(commented?.data).toStrictEqual({ text: "after" });
		store.close();
	});

	it("reports the stream length as the folded sequence", async () => {
		// Including the quarantine marker: the fold's `seq` is where the stream
		// actually ends, which is what a caller stores as its checkpoint.
		const store = await poisonedStream(storeForTest());
		const result = await fold(store);
		const events = await collectStream(store, "ticket:1");
		expect(result.seq).toBe(events.length);
		store.close();
	});

	it("returns a frozen result", async () => {
		// The result is a snapshot of a fold that already happened; a caller
		// editing it would be editing something with no store behind it.
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
