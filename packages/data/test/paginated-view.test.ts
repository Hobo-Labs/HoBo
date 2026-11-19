import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import { describe, expect, it } from "vitest";
import { createPaginatedEventView } from "../src/paginated-view.js";

const actor = { kind: "service", id: "tickets" } as const;
const indexes = { createdAt: "string", priority: "number" } as const;
const row = (id: string, createdAt: string, seq = 1, title = id) => ({
	id,
	streamId: `ticket:${id}`,
	seq,
	createdAt,
	priority: seq,
	title,
});

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "hobo-paginated-"));
	const store = createRuntimeLocalEventStore({ dataDir: directory });
	const options = {
		store,
		streamId: "projection:tickets",
		resource: "tickets",
		tenant: "shop",
		actor,
		indexes,
	};
	return {
		directory,
		store,
		options,
		close() {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

describe("event-backed pagination", () => {
	it("keeps keyset pages stable across earlier inserts and restores them from the journal", async () => {
		const f = fixture();
		try {
			const view = await createPaginatedEventView(f.options);
			for (const item of [
				row("a", "10"),
				row("b", "11"),
				row("c", "12"),
				row("d", "13"),
			])
				await view.upsert(item);
			const first = await view.order("createdAt").paginate({ limit: 2 });
			expect(first.items.map((item) => item.id)).toEqual(["a", "b"]);
			expect(first.seq).toEqual({ "ticket:a": 1, "ticket:b": 1 });
			await view.upsert(row("earlier", "09"));
			const next = await view
				.order("createdAt")
				.paginate({ cursor: first.nextCursor, limit: 2 });
			expect(next.items.map((item) => item.id)).toEqual(["c", "d"]);
			f.store.close();
			const reopened = createRuntimeLocalEventStore({ dataDir: f.directory });
			try {
				const restored = await createPaginatedEventView({
					...f.options,
					store: reopened,
				});
				expect(
					await restored
						.order("createdAt")
						.paginate({ cursor: first.nextCursor, limit: 2 }),
				).toEqual(next);
			} finally {
				reopened.close();
			}
		} finally {
			rmSync(f.directory, { recursive: true, force: true });
		}
	});

	it("keeps tombstone revisions and rejects stale mutations", async () => {
		const f = fixture();
		try {
			const view = await createPaginatedEventView(f.options);
			await view.upsert(row("a", "10"));
			await view.upsert(row("b", "11"));
			await view.upsert(row("c", "12"));
			await view.delete("b", 2);
			const page = await view.order("createdAt").paginate({ limit: 2 });
			expect(page.items.map((item) => item.id)).toEqual(["a", "c"]);
			expect(page.seq).toEqual({ "ticket:a": 1, "ticket:b": 2, "ticket:c": 1 });
			await expect(view.upsert(row("b", "11", 2))).rejects.toThrow(
				/sequence must advance/,
			);
			await view.upsert(row("b", "11", 3));
			expect(
				(await view.order("createdAt").paginate({ limit: 3 })).items.map(
					(item) => item.id,
				),
			).toEqual(["a", "b", "c"]);
		} finally {
			f.close();
		}
	});

	it("rejects invalid indexes, limits, row types, and cursors from another order or stream", async () => {
		const f = fixture();
		try {
			const view = await createPaginatedEventView(f.options);
			await view.upsert(row("a", "10"));
			const page = await view.order("createdAt").paginate({ limit: 1 });
			expect(() => view.order("title")).toThrow(/not indexable/);
			await expect(
				view.order("createdAt").paginate({ limit: 0 }),
			).rejects.toThrow(/limit/);
			await expect(
				view.order("createdAt").paginate({ cursor: "!", limit: 1 }),
			).rejects.toThrow(/cursor/);
			await expect(
				view.order("priority").paginate({ cursor: page.nextCursor, limit: 1 }),
			).rejects.toThrow(/cursor/);
			const other = await createPaginatedEventView({
				...f.options,
				streamId: "projection:other",
			});
			await expect(
				other
					.order("createdAt")
					.paginate({ cursor: page.nextCursor, limit: 1 }),
			).rejects.toThrow(/cursor/);
			await expect(
				view.upsert({ ...row("b", "11"), priority: "high" }),
			).rejects.toThrow(/indexed number/);
		} finally {
			f.close();
		}
	});

	it("serializes concurrent writers and exposes committed data.Changed events", async () => {
		const f = fixture();
		try {
			const first = await createPaginatedEventView(f.options);
			const second = await createPaginatedEventView(f.options);
			await Promise.all([
				first.upsert(row("a", "10")),
				second.upsert(row("b", "11")),
			]);
			expect(
				(await first.order("createdAt").paginate({ limit: 2 })).items.map(
					(item) => item.id,
				),
			).toEqual(["a", "b"]);
			const events = [];
			for await (const event of f.store.read(f.options.streamId))
				events.push(event);
			expect(events.map((event) => event.type)).toEqual([
				"data.Changed",
				"data.Changed",
			]);
			expect(events.map((event) => event.seq)).toEqual([1, 2]);
		} finally {
			f.close();
		}
	});
	it("updates only the active window and extends it on loadMore", async () => {
		const f = fixture();
		try {
			const view = await createPaginatedEventView(f.options);
			const writer = await createPaginatedEventView(f.options);
			await writer.upsert(row("a", "10"));
			await writer.upsert(row("b", "11"));
			await writer.upsert(row("c", "12"));
			await writer.upsert(row("d", "13"));
			const pushed: Array<{
				ids: string[];
				titles: string[];
				seq: Readonly<Record<string, number>>;
			}> = [];
			const query = await view.order("createdAt").watch({
				limit: 2,
				onPush(page) {
					pushed.push({
						ids: page.items.map((item) => item.id),
						titles: page.items.map((item) => String(item.title)),
						seq: page.seq,
					});
				},
			});
			await writer.upsert(row("d", "13", 2, "outside"));
			await query.drain();
			expect(pushed).toHaveLength(1);
			await writer.upsert(row("b", "11", 2, "updated"));
			await query.drain();
			expect(pushed.at(-1)).toEqual({
				ids: ["a", "b"],
				titles: ["a", "updated"],
				seq: { "ticket:a": 1, "ticket:b": 2 },
			});
			const extended = await query.loadMore();
			expect(extended.items.map((item) => item.id)).toEqual([
				"a",
				"b",
				"c",
				"d",
			]);
			await writer.upsert(row("d", "13", 3, "inside"));
			await query.drain();
			expect(pushed.at(-1)?.titles).toEqual(["a", "updated", "c", "inside"]);
			await writer.delete("b", 3);
			await query.drain();
			expect(query.current().items.map((item) => item.id)).toEqual([
				"a",
				"c",
				"d",
			]);
			expect(query.current().seq).toEqual({
				"ticket:a": 1,
				"ticket:b": 3,
				"ticket:c": 1,
				"ticket:d": 3,
			});
			const count = pushed.length;
			query.unsubscribe();
			await writer.upsert(row("a", "10", 2));
			await query.drain();
			expect(pushed).toHaveLength(count);
			view.close();
			writer.close();
		} finally {
			f.close();
		}
	});

	it("wakes an initially empty window when a matching row arrives", async () => {
		const f = fixture();
		try {
			const view = await createPaginatedEventView(f.options);
			const pushed: string[][] = [];
			const query = await view.order("createdAt").watch({
				limit: 1,
				onPush(page) {
					pushed.push(page.items.map((item) => item.id));
				},
			});
			await view.upsert(row("a", "10"));
			await query.drain();
			expect(pushed).toEqual([[], ["a"]]);
			query.unsubscribe();
			view.close();
		} finally {
			f.close();
		}
	});

	it("wakes an empty window after a cursor without including earlier rows", async () => {
		const f = fixture();
		try {
			const view = await createPaginatedEventView(f.options);
			await view.upsert(row("a", "10"));
			const first = await view.order("createdAt").paginate({ limit: 1 });
			const pushed: string[][] = [];
			const query = await view.order("createdAt").watch({
				cursor: first.nextCursor,
				limit: 1,
				onPush(page) {
					pushed.push(page.items.map((item) => item.id));
				},
			});
			await view.upsert(row("earlier", "09"));
			await view.upsert(row("b", "11"));
			await query.drain();
			expect(pushed).toEqual([[], ["b"]]);
			query.unsubscribe();
			view.close();
		} finally {
			f.close();
		}
	});

	it("polls changes committed through another journal connection", async () => {
		const f = fixture();
		const otherStore = createRuntimeLocalEventStore({ dataDir: f.directory });
		try {
			const view = await createPaginatedEventView({
				...f.options,
				pollIntervalMs: 10,
			});
			const writer = await createPaginatedEventView({
				...f.options,
				store: otherStore,
			});
			let resolvePush = () => {};
			const received = new Promise<void>((resolve) => {
				resolvePush = resolve;
			});
			const query = await view.order("createdAt").watch({
				limit: 1,
				onPush(page) {
					if (page.items.length) resolvePush();
				},
			});
			await writer.upsert(row("a", "10"));
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					received,
					new Promise((_, reject) => {
						timeout = setTimeout(
							() => reject(new Error("poll did not deliver")),
							2_000,
						);
					}),
				]);
			} finally {
				if (timeout) clearTimeout(timeout);
			}
			expect(query.current().items.map((item) => item.id)).toEqual(["a"]);
			query.unsubscribe();
			view.close();
			writer.close();
		} finally {
			otherStore.close();
			f.close();
		}
	});

	it("reports subscriber failures without losing later updates", async () => {
		const f = fixture();
		try {
			const view = await createPaginatedEventView(f.options);
			let calls = 0;
			const query = await view.order("createdAt").watch({
				limit: 1,
				onPush() {
					calls += 1;
					if (calls === 1) throw new Error("consumer failed");
				},
			});
			await expect(query.drain()).rejects.toThrow(
				/paginated subscription failed/,
			);
			await view.upsert(row("a", "10"));
			await query.drain();
			expect(query.current().items.map((item) => item.id)).toEqual(["a"]);
			expect(calls).toBe(2);
			query.unsubscribe();
			view.close();
		} finally {
			f.close();
		}
	});
	it("serializes asynchronous subscriber callbacks and reports their failures", async () => {
		const f = fixture();
		try {
			const view = await createPaginatedEventView(f.options);
			let release = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const seen: string[] = [];
			const query = await view.order("createdAt").watch({
				limit: 1,
				async onPush(page) {
					const item = page.items[0];
					seen.push(item ? String(item.seq) : "empty");
					if (!item) await gate;
					if (item?.seq === 2) throw new Error("async consumer failed");
				},
			});
			await view.upsert(row("a", "10"));
			expect(seen).toEqual(["empty"]);
			release();
			await query.drain();
			expect(seen).toEqual(["empty", "1"]);
			await view.upsert(row("a", "10", 2));
			await expect(query.drain()).rejects.toThrow(
				/paginated subscription failed/,
			);
			await view.upsert(row("a", "10", 3));
			await query.drain();
			expect(seen).toEqual(["empty", "1", "2", "3"]);
			query.unsubscribe();
			view.close();
		} finally {
			f.close();
		}
	});
	it("keeps displaced rows when inserts land inside a full window", async () => {
		const f = fixture();
		try {
			const view = await createPaginatedEventView(f.options);
			for (const item of [
				row("a", "10"),
				row("b", "12"),
				row("c", "13"),
				row("d", "14"),
			])
				await view.upsert(item);
			const query = await view.order("createdAt").watch({ limit: 2 });
			await view.upsert(row("between", "11"));
			await query.drain();
			expect(query.current().items.map((item) => item.id)).toEqual([
				"a",
				"between",
			]);
			expect((await query.loadMore()).items.map((item) => item.id)).toEqual([
				"a",
				"between",
				"b",
				"c",
				"d",
			]);
			query.unsubscribe();
			view.close();
		} finally {
			f.close();
		}
	});

	it("preserves observed revisions when a row moves out of the window", async () => {
		const f = fixture();
		try {
			const view = await createPaginatedEventView(f.options);
			await view.upsert(row("a", "10"));
			await view.upsert(row("b", "11"));
			const query = await view.order("createdAt").watch({ limit: 2 });
			await view.upsert(row("b", "20", 2));
			await query.drain();
			expect(query.current().items.map((item) => item.id)).toEqual(["a"]);
			expect(query.current().seq).toEqual({ "ticket:a": 1, "ticket:b": 2 });
			await view.upsert(row("b", "20", 3));
			await query.drain();
			expect(query.current().seq["ticket:b"]).toBe(2);
			expect((await query.loadMore()).seq["ticket:b"]).toBe(3);
			query.unsubscribe();
			view.close();
		} finally {
			f.close();
		}
	});
});
