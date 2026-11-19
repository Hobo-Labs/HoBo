import { expect, it, vi } from "vitest";
import { createPostgresEventStore } from "../src/index.js";
import { collect, describeLive, liveStore, OPTS } from "./support/live.js";

it("rejects an empty outbox destination before opening a transaction", async () => {
	const connect = vi.fn(async () => {
		throw new Error("unexpected connection");
	});
	const pool = { connect, async end() {} };
	const store = createPostgresEventStore({
		config: { schema: "effects_test" },
		pool,
	});
	try {
		await expect(
			store.commit({
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
		expect(connect).not.toHaveBeenCalled();
		await expect(
			store.commit({
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
		expect(connect).not.toHaveBeenCalled();
	} finally {
		await store.end();
	}
});

describeLive("PostgreSQL durable effect validation", () => {
	it("leaves the stream empty when an outbox destination is missing", async () => {
		const store = liveStore();
		await expect(
			store.commit({
				streamId: "items",
				events: [{ type: "item.Added", data: {} }],
				append: { ...OPTS, expectedSeq: 0 },
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
		expect(await collect(store.read("items"))).toEqual([]);
	});
});
