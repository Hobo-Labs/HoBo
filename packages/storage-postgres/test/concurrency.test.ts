import type { EventPosition } from "@hobo/core";
import { expect, it } from "vitest";
import {
	collect,
	describeLive,
	freshSchema,
	liveStore,
	OPTS,
} from "./support/live.js";

describeLive("multi-writer ordering", () => {
	it("never lets a position-paging reader skip an event committed concurrently by other writers", async () => {
		const schema = freshSchema();
		const writers = Array.from({ length: 6 }, () =>
			liveStore({ schema, config: { poolSize: 2 } }),
		);
		const reader = liveStore({ schema, config: { poolSize: 1 } });
		await reader.ready();
		const perWriter = 30;
		let writing = true;
		const seen: bigint[] = [];
		const readerLoop = (async () => {
			let after = 0n;
			while (writing || after < BigInt(writers.length * perWriter)) {
				// SAFETY: test-local position bookkeeping; after only holds positions the store returned.
				const page = await collect(
					reader.readAll({ after: after as EventPosition, limit: 7 }),
				);
				for (const item of page) {
					seen.push(item.position);
					after = item.position;
				}
				if (page.length === 0)
					await new Promise((resolve) => setTimeout(resolve, 2));
			}
		})();
		await Promise.all(
			writers.map(async (writer, w) => {
				for (let n = 0; n < perWriter; n += 1) {
					await writer.append(`w:${w}`, [{ type: "w.Wrote", data: { n } }], {
						...OPTS,
						expectedSeq: n,
					});
				}
			}),
		);
		writing = false;
		await readerLoop;
		const total = writers.length * perWriter;
		expect(seen).toEqual(
			Array.from({ length: total }, (_, i) => BigInt(i + 1)),
		);
	});

	it("keeps per-stream sequences contiguous under contention, with exactly one winner per seq", async () => {
		const schema = freshSchema();
		const stores = Array.from({ length: 4 }, () =>
			liveStore({ schema, config: { poolSize: 2 } }),
		);
		await stores[0]?.ready();
		let wins = 0;
		await Promise.all(
			stores.map(async (store) => {
				for (let attempt = 0; attempt < 25; attempt += 1) {
					const head = await store.loadStreamHead("hot");
					try {
						await store.append("hot", [{ type: "hot.Bumped", data: {} }], {
							...OPTS,
							expectedSeq: head?.revision ?? 0,
						});
						wins += 1;
					} catch (error) {
						expect(error).toMatchObject({
							code: "OPTIMISTIC_SEQUENCE_CONFLICT",
						});
					}
				}
			}),
		);
		const events = await collect(stores[0]?.read("hot") ?? []);
		expect(events).toHaveLength(wins);
		expect(events.every((event, index) => event.seq === index + 1)).toBe(true);
	});
});
