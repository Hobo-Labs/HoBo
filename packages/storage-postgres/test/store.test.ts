import type { EventEnvelope } from "@hobo/core";
import { expect, it } from "vitest";
import { eventIdFor } from "../src/index.js";
import {
	adminQuery,
	collect,
	describeLive,
	freshSchema,
	liveStore,
	manualClock,
	OPTS,
} from "./support/live.js";

describeLive(
	"PostgreSQL DurableEventStore: append, read, fence, effects",
	() => {
		it("allocates gapless global positions across streams and derives event ids from them", async () => {
			const store = liveStore();
			const a = await store.append(
				"order:a",
				[
					{ type: "order.Created", data: { n: 1 } },
					{ type: "order.Paid", data: {} },
				],
				{ ...OPTS, expectedSeq: 0 },
			);
			const b = await store.append(
				"order:b",
				[{ type: "order.Created", data: { n: 2 } }],
				{ ...OPTS, expectedSeq: 0 },
			);
			expect([
				a.firstPosition,
				a.lastPosition,
				b.firstPosition,
				b.lastPosition,
			]).toEqual([1n, 2n, 3n, 3n]);
			const all = await collect(store.readAll());
			expect(all.map((item) => item.position)).toEqual([1n, 2n, 3n]);
			for (const { position, event } of all) {
				expect(event.id).toBe(eventIdFor(Date.parse(event.ts), position));
			}
			expect(all.map((item) => [item.event.streamId, item.event.seq])).toEqual([
				["order:a", 1],
				["order:a", 2],
				["order:b", 1],
			]);
		});

		it("rejects a stale expectedSeq and writes nothing", async () => {
			const store = liveStore();
			await store.append("s", [{ type: "s.Started", data: {} }], {
				...OPTS,
				expectedSeq: 0,
			});
			await expect(
				store.append("s", [{ type: "s.Raced", data: {} }], {
					...OPTS,
					expectedSeq: 0,
				}),
			).rejects.toMatchObject({
				code: "OPTIMISTIC_SEQUENCE_CONFLICT",
				expectedSeq: 0,
				actualSeq: 1,
			});
			expect(await collect(store.read("s"))).toHaveLength(1);
			expect(await collect(store.readAll())).toHaveLength(1);
		});

		it("enters fenced mode on the first fenced append and refuses stale and missing fences", async () => {
			const store = liveStore();
			await store.append("actor:a", [{ type: "actor.Opened", data: {} }], {
				...OPTS,
				expectedSeq: 0,
				fenceToken: 5n,
			});
			await expect(
				store.append("actor:a", [{ type: "actor.Stale", data: {} }], {
					...OPTS,
					expectedSeq: 1,
					fenceToken: 3n,
				}),
			).rejects.toMatchObject({
				code: "STALE_FENCE",
				provided: 3n,
				stored: 5n,
			});
			await expect(
				store.append("actor:a", [{ type: "actor.Unfenced", data: {} }], {
					...OPTS,
					expectedSeq: 1,
				}),
			).rejects.toMatchObject({ code: "MISSING_FENCE" });
			await store.append("actor:a", [{ type: "actor.Moved", data: {} }], {
				...OPTS,
				expectedSeq: 1,
				fenceToken: 7n,
			});
			expect(await store.loadStreamHead("actor:a")).toEqual({
				streamId: "actor:a",
				revision: 2,
				ownerEpoch: 7n,
			});
			await expect(
				store.append("actor:a", [{ type: "actor.Old", data: {} }], {
					...OPTS,
					expectedSeq: 2,
					fenceToken: 5n,
				}),
			).rejects.toMatchObject({ code: "STALE_FENCE" });
		});

		it("dedupes idempotency keys across commits and within one batch", async () => {
			const store = liveStore();
			const event = {
				type: "pay.Captured",
				data: { amount: 1 },
				meta: { idempotencyKey: "k1" },
			};
			const first = await store.append("pay", [event, { ...event }], {
				...OPTS,
				expectedSeq: 0,
			});
			expect(first.appended).toHaveLength(1);
			expect(first.deduped).toHaveLength(1);
			expect(first.deduped[0]?.id).toBe(first.appended[0]?.id);
			const retry = await store.append("pay", [event], {
				...OPTS,
				expectedSeq: 0,
			});
			expect(retry.appended).toHaveLength(0);
			expect(retry.deduped[0]?.id).toBe(first.appended[0]?.id);
		});

		it("filters readAll by stream, type, tenant and lane, and caps a page at maxReadPage", async () => {
			const store = liveStore();
			await store.append("x", [{ type: "x.One", data: {} }], {
				...OPTS,
				expectedSeq: 0,
				lane: "blue",
			});
			await store.append("y", [{ type: "y.Two", data: {} }], {
				...OPTS,
				tenant: "t2",
				expectedSeq: 0,
			});
			await store.append("x", [{ type: "x.Three", data: {} }], {
				...OPTS,
				expectedSeq: 1,
			});
			const types = async (options: Parameters<typeof store.readAll>[0]) =>
				(await collect(store.readAll(options))).map((item) => item.event.type);
			expect(await types({ filter: { streamId: "x" } })).toEqual([
				"x.One",
				"x.Three",
			]);
			expect(await types({ filter: { type: "y.Two" } })).toEqual(["y.Two"]);
			expect(await types({ tenant: "t2" })).toEqual(["y.Two"]);
			expect(await types({ lane: "blue" })).toEqual(["x.One"]);
			expect(await types({ after: 1n, limit: 1 })).toEqual(["y.Two"]);
			expect(await types({ limit: 5_000 })).toHaveLength(3);
		});

		it("reads a stream longer than one page in order", async () => {
			const store = liveStore();
			for (let batch = 0; batch < 5; batch += 1) {
				await store.append(
					"long",
					Array.from({ length: 250 }, (_, i) => ({
						type: "long.Ticked",
						data: { i: batch * 250 + i },
					})),
					{ ...OPTS, expectedSeq: batch * 250 },
				);
			}
			const events = await collect(store.read("long"));
			expect(events).toHaveLength(1250);
			expect(events.every((event, index) => event.seq === index + 1)).toBe(
				true,
			);
			expect(
				(await collect(store.read("long", 1201))).map((e) => e.seq)[0],
			).toBe(1201);
		});

		it("stages every durable effect kind atomically with the events and dedupes retries", async () => {
			const store = liveStore();
			const effects = [
				{
					kind: "queue" as const,
					queueName: "q",
					idempotencyKey: "q1",
					body: { a: 1 },
				},
				{
					kind: "actor-signal" as const,
					actorKey: "actor-1",
					idempotencyKey: "s1",
					body: { b: 2 },
				},
				{
					kind: "timer" as const,
					timerKind: "sleep" as const,
					subjectId: "subj",
					idempotencyKey: "t1",
					dueAt: "2026-11-12T01:00:00.000Z",
				},
				{
					kind: "cron" as const,
					scheduleId: "nightly",
					everyMs: 86_400_000,
					startAt: "2026-11-12T00:00:00.000Z",
					nextFireAt: "2026-11-13T00:00:00.000Z",
				},
				{
					kind: "outbox" as const,
					destination: "webhook:a",
					idempotencyKey: "o1",
					payload: { c: 3 },
					headers: { "x-k": "v" },
				},
			];
			const first = await store.commit({
				streamId: "fx",
				events: [
					{ type: "fx.Happened", data: {}, meta: { idempotencyKey: "e1" } },
				],
				append: { ...OPTS, expectedSeq: 0 },
				effects,
			});
			expect(
				first.effects.map((receipt) => [receipt.kind, receipt.deduped]),
			).toEqual([
				["queue", false],
				["actor-signal", false],
				["timer", false],
				["cron", false],
				["outbox", false],
			]);
			expect(first.effects.map((receipt) => receipt.id)).toEqual([
				"msg:q:q1",
				"msg:actor:actor-1:s1",
				"timer:subj:t1",
				"nightly",
				"outbox:webhook:a:o1",
			]);
			const retry = await store.commit({
				streamId: "fx",
				events: [
					{ type: "fx.Happened", data: {}, meta: { idempotencyKey: "e1" } },
				],
				append: { ...OPTS, expectedSeq: 0 },
				effects,
			});
			expect(retry.appended).toHaveLength(0);
			expect(retry.effects.every((receipt) => receipt.deduped)).toBe(true);
			const [queue] = await adminQuery(
				`SELECT count(*)::text AS count, max(created_position)::text AS created_position FROM "${store.schema}".queue_messages`,
			);
			expect(queue).toEqual({ count: "2", created_position: "1" });
		});

		it("rolls back staged effects when the event append conflicts", async () => {
			const store = liveStore();
			await store.append("fx2", [{ type: "fx.One", data: {} }], {
				...OPTS,
				expectedSeq: 0,
			});
			await expect(
				store.commit({
					streamId: "fx2",
					events: [{ type: "fx.Two", data: {} }],
					append: { ...OPTS, expectedSeq: 0 },
					effects: [
						{
							kind: "outbox",
							destination: "d",
							idempotencyKey: "never",
							payload: {},
						},
					],
				}),
			).rejects.toMatchObject({ code: "OPTIMISTIC_SEQUENCE_CONFLICT" });
			const rows = await adminQuery(`SELECT 1 FROM "${store.schema}".outbox`);
			expect(rows).toHaveLength(0);
		});

		it("saves and loads snapshots and refuses one ahead of the stream head", async () => {
			const store = liveStore();
			await store.append(
				"snap",
				[
					{ type: "snap.A", data: {} },
					{ type: "snap.B", data: {} },
				],
				{ ...OPTS, expectedSeq: 0 },
			);
			await store.snapshot("snap", { count: 1 }, 1);
			await store.snapshot("snap", { count: 2 }, 2);
			expect(await store.loadSnapshot<{ count: number }>("snap")).toMatchObject(
				{ seq: 2, state: { count: 2 } },
			);
			await expect(store.snapshot("snap", {}, 3)).rejects.toMatchObject({
				code: "SNAPSHOT_AHEAD",
			});
			expect(await store.loadSnapshot("missing")).toBeUndefined();
		});

		it("does not re-quarantine an already quarantined event after a restart", async () => {
			const schema = freshSchema();
			const handlers = {
				"t.Opened": () => {
					throw new Error("bad");
				},
			};
			const first = liveStore({ schema });
			await first.append("t", [{ type: "t.Opened", data: {} }], {
				...OPTS,
				expectedSeq: 0,
			});
			const once = await first.fold("t", { initialState: {}, handlers });
			expect(once.quarantined).toHaveLength(1);
			await first.end();
			const reopened = liveStore({ schema });
			const twice = await reopened.fold("t", { initialState: {}, handlers });
			expect(twice.quarantined).toHaveLength(0);
			expect(await collect(reopened.read("t"))).toHaveLength(2);
		});

		it("wakes live subscribers in position order, including events committed by another store instance", async () => {
			const schema = freshSchema();
			const reader = liveStore({ schema });
			const writer = liveStore({ schema });
			await reader.ready();
			await writer.append("pre", [{ type: "pre.Existing", data: {} }], {
				...OPTS,
				expectedSeq: 0,
			});
			const seen: EventEnvelope[] = [];
			const done = new Promise<void>((resolve) => {
				reader.subscribe({}, (event) => {
					seen.push(event);
					if (seen.length === 3) resolve();
				});
			});
			const filtered: string[] = [];
			const sub = reader.subscribe({ type: "live.Two" }, (event) => {
				filtered.push(event.type);
			});
			await new Promise((resolve) => setTimeout(resolve, 200));
			await writer.append("live", [{ type: "live.One", data: {} }], {
				...OPTS,
				expectedSeq: 0,
			});
			await reader.append("live", [{ type: "live.Two", data: {} }], {
				...OPTS,
				expectedSeq: 1,
			});
			await writer.append("live", [{ type: "live.Three", data: {} }], {
				...OPTS,
				expectedSeq: 2,
			});
			await done;
			expect(seen.map((event) => event.type)).toEqual([
				"live.One",
				"live.Two",
				"live.Three",
			]);
			expect(filtered).toEqual(["live.Two"]);
			sub.unsubscribe();
		});

		it("refuses inputs beyond the EventStore limits with INVALID_INPUT", async () => {
			const store = liveStore();
			await expect(
				store.append(
					"big",
					Array.from({ length: 257 }, () => ({ type: "big.E", data: {} })),
					{ ...OPTS, expectedSeq: 0 },
				),
			).rejects.toMatchObject({
				code: "INVALID_INPUT",
				failure: "invalid-input",
			});
			await expect(
				store.append(
					"big",
					[{ type: "big.E", data: { blob: "x".repeat(1_048_577) } }],
					{ ...OPTS, expectedSeq: 0 },
				),
			).rejects.toMatchObject({ code: "INVALID_INPUT" });
			await expect(
				store.append("big", [{ type: "big.E", data: {} }], {
					...OPTS,
					expectedSeq: 0,
					fenceToken: 1n << 63n,
				}),
			).rejects.toMatchObject({ code: "INVALID_INPUT" });
			await expect(
				store.append("", [{ type: "big.E" }], { ...OPTS, expectedSeq: 0 }),
			).rejects.toMatchObject({
				code: "INVALID_INPUT",
			});
		});

		it("reports a row written with an unknown codec as UNSUPPORTED_CODEC", async () => {
			const store = liveStore();
			await store.append("codec", [{ type: "codec.Ok", data: {} }], {
				...OPTS,
				expectedSeq: 0,
			});
			await adminQuery(
				`UPDATE "${store.schema}".events SET payload_codec = 'protobuf-v9'`,
			);
			await expect(collect(store.read("codec"))).rejects.toMatchObject({
				code: "UNSUPPORTED_CODEC",
			});
		});

		it("stamps every row from the injected clock (replay-deterministic, I8)", async () => {
			const clock = manualClock("2030-01-01T00:00:00.000Z");
			const store = liveStore({ clock });
			const result = await store.append(
				"clock",
				[{ type: "clock.Ticked", data: {} }],
				{ ...OPTS, expectedSeq: 0 },
			);
			expect(result.appended[0]?.ts).toBe("2030-01-01T00:00:00.000Z");
			const [row] = await adminQuery(
				`SELECT created_at FROM "${store.schema}".streams`,
			);
			expect(row?.created_at).toBe("2030-01-01T00:00:00.000Z");
		});
	},
);
