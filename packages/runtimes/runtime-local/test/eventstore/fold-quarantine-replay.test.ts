import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createRuntimeLocalEventStore } from "../../src/eventstore/eventstore.js";

it("keeps a quarantined event skipped and reported after the handler changes and the store reopens", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "hobo-quarantine-replay-"));
	const initial = createRuntimeLocalEventStore({ dataDir });
	let initialOpen = true;
	try {
		await initial.append(
			"items:1",
			[
				{ type: "item.Added", data: { n: 1 } },
				{ type: "item.Added", data: { n: 2 } },
			],
			{ expectedSeq: 0, actor: { kind: "user", id: "u1" }, tenant: "tenant-a" },
		);
		const first = await initial.fold("items:1", {
			initialState: 0,
			handlers: {
				"item.Added": (state, event) => {
					if (event.seq === 1) throw new Error("poison");
					return state + 1;
				},
			},
		});
		expect(first.state).toBe(1);
		expect(first.quarantined).toHaveLength(1);
		const repeated = await initial.fold("items:1", {
			initialState: 0,
			handlers: { "item.Added": (state) => state + 1 },
		});
		expect(repeated.state).toBe(1);
		expect(repeated.quarantined).toEqual(first.quarantined);
		initial.close();
		initialOpen = false;
		const reopened = createRuntimeLocalEventStore({ dataDir });
		try {
			const replay = await reopened.fold("items:1", {
				initialState: 0,
				handlers: { "item.Added": (state) => state + 1 },
			});
			expect(replay.state).toBe(1);
			expect(replay.quarantined).toEqual(first.quarantined);
			const events = [];
			for await (const event of reopened.read("items:1")) events.push(event);
			expect(events.map((event) => event.type)).toEqual([
				"item.Added",
				"item.Added",
				"item.Quarantined",
			]);
		} finally {
			reopened.close();
		}
	} finally {
		if (initialOpen) initial.close();
		rmSync(dataDir, { recursive: true, force: true });
	}
});

it("deduplicates concurrent quarantine attempts from separate store handles", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "hobo-quarantine-concurrent-"));
	const first = createRuntimeLocalEventStore({ dataDir });
	const second = createRuntimeLocalEventStore({ dataDir });
	try {
		await first.append("items:1", [{ type: "item.Added", data: {} }], {
			expectedSeq: 0,
			actor: { kind: "user", id: "u1" },
			tenant: "tenant-a",
		});
		const fold = (store: typeof first) =>
			store.fold("items:1", {
				initialState: 0,
				handlers: {
					"item.Added": () => {
						throw new Error("poison");
					},
				},
			});
		const [left, right] = await Promise.all([fold(first), fold(second)]);
		expect(left.quarantined).toEqual(right.quarantined);
		const events = [];
		for await (const event of first.read("items:1")) events.push(event);
		expect(
			events.filter((event) => event.type === "item.Quarantined"),
		).toHaveLength(1);
	} finally {
		first.close();
		second.close();
		rmSync(dataDir, { recursive: true, force: true });
	}
});

it("rejects a quarantine marker that targets a different event identity", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "hobo-quarantine-invalid-"));
	const store = createRuntimeLocalEventStore({ dataDir });
	try {
		await store.append(
			"items:1",
			[
				{ type: "item.Added", data: {} },
				{
					type: "item.Quarantined",
					data: { offendingSeq: 1, reason: "invalid" },
					meta: { quarantines: "other-event" },
				},
			],
			{ expectedSeq: 0, actor: { kind: "user", id: "u1" }, tenant: "tenant-a" },
		);
		await expect(
			store.fold("items:1", {
				initialState: 0,
				handlers: { "item.Added": (state) => state + 1 },
			}),
		).rejects.toThrow("invalid quarantine target");
	} finally {
		store.close();
		rmSync(dataDir, { recursive: true, force: true });
	}
});
