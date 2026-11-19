import { expect, it } from "vitest";
import { createMemoryNodeSqliteDriver, SqliteJournal } from "../src/index.js";

it("rejects an empty outbox destination before appending its event", async () => {
	const journal = new SqliteJournal(createMemoryNodeSqliteDriver(), {
		nativePragmas: false,
	});
	try {
		await expect(
			journal.commit({
				streamId: "items",
				events: [{ type: "item.Added", data: {} }],
				append: {
					expectedSeq: 0,
					tenant: "workspace",
					actor: { kind: "user", id: "operator" },
				},
				effects: [
					{
						kind: "outbox",
						destination: "",
						idempotencyKey: "one",
						payload: {},
					},
				],
			}),
		).rejects.toMatchObject({ path: "effect.destination" });
		const events = [];
		for await (const event of journal.read("items")) events.push(event);
		expect(events).toEqual([]);
	} finally {
		journal.close();
	}
});

it("rejects a null effects collection instead of dropping it", async () => {
	const journal = new SqliteJournal(createMemoryNodeSqliteDriver(), {
		nativePragmas: false,
	});
	try {
		await expect(
			journal.commit({
				streamId: "items",
				events: [{ type: "item.Added", data: {} }],
				append: {
					expectedSeq: 0,
					tenant: "workspace",
					actor: { kind: "user", id: "operator" },
				},
				effects: null as never,
			}),
		).rejects.toThrow("effects must be an array");
		const events = [];
		for await (const event of journal.read("items")) events.push(event);
		expect(events).toEqual([]);
	} finally {
		journal.close();
	}
});
